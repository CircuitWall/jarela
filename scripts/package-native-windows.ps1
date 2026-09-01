# Build a native Windows MSI from a staged Jarela release payload.

[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$StagedDir,
  [Parameter(Mandatory=$true)][string]$Version,
  [string]$OutDir = 'dist'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $StagedDir -PathType Container)) {
  throw "staged dir not found: $StagedDir"
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
if (-not $node) { throw 'node not found on PATH' }

$wix = Get-Command wix.exe -ErrorAction SilentlyContinue
if (-not $wix) { $wix = Get-Command wix -ErrorAction SilentlyContinue }
if (-not $wix) { throw 'wix not found on PATH. Install with: dotnet tool install --global wix' }

$stagedFull = (Resolve-Path -LiteralPath $StagedDir).Path
$outFull = if (Test-Path -LiteralPath $OutDir) { (Resolve-Path -LiteralPath $OutDir).Path } else { (New-Item -ItemType Directory -Force -Path $OutDir).FullName }
$work = Join-Path ([System.IO.Path]::GetTempPath()) ('jarela-msi-' + [Guid]::NewGuid().ToString('N'))
$payload = Join-Path $work 'payload'
New-Item -ItemType Directory -Force -Path $payload | Out-Null

function XmlEscape([string]$Value) {
  return [Security.SecurityElement]::Escape($Value)
}

function New-WixId([string]$Prefix, [string]$Value) {
  $sha1 = [System.Security.Cryptography.SHA1]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $hash = $sha1.ComputeHash($bytes)
    $hex = -join ($hash[0..9] | ForEach-Object { $_.ToString('x2') })
    return ($Prefix + $hex)
  } finally {
    $sha1.Dispose()
  }
}

function Get-RelativePath([string]$Base, [string]$Path) {
  $baseUri = [Uri]((Join-Path $Base '.') -replace '\\', '/')
  $pathUri = [Uri]($Path -replace '\\', '/')
  return [Uri]::UnescapeDataString($baseUri.MakeRelativeUri($pathUri).ToString()).Replace('/', '\')
}

try {
  Copy-Item -Recurse -Force -Path (Join-Path $stagedFull '*') -Destination $payload
  New-Item -ItemType Directory -Force -Path (Join-Path $payload 'runtime') | Out-Null
  Copy-Item -Force -Path $node.Source -Destination (Join-Path $payload 'runtime\node.exe')
  @('@echo off', 'setlocal', '"%~dp0runtime\node.exe" "%~dp0scripts\jarela-bin.mjs" %*', 'exit /b %ERRORLEVEL%') |
    Set-Content -Encoding ascii -Path (Join-Path $payload 'jarela.cmd')

  $componentRefs = New-Object System.Collections.Generic.List[string]

  function EmitDirectory([string]$DirPath, [int]$Indent) {
    $indentText = ' ' * $Indent
    $xml = New-Object System.Collections.Generic.List[string]
    $files = Get-ChildItem -LiteralPath $DirPath -File -Force | Sort-Object Name
    foreach ($file in $files) {
      $relative = Get-RelativePath $payload $file.FullName
      $componentId = New-WixId 'C' $relative
      $fileId = New-WixId 'F' $relative
      $componentRefs.Add($componentId)
      $source = XmlEscape $file.FullName
      $xml.Add("$indentText<Component Id=`"$componentId`" Guid=`"*`">")
      $xml.Add("$indentText  <File Id=`"$fileId`" Source=`"$source`" KeyPath=`"yes`" />")
      $xml.Add("$indentText</Component>")
    }

    $dirs = Get-ChildItem -LiteralPath $DirPath -Directory -Force | Sort-Object Name
    foreach ($dir in $dirs) {
      $relative = Get-RelativePath $payload $dir.FullName
      $dirId = New-WixId 'D' $relative
      $name = XmlEscape $dir.Name
      $xml.Add("$indentText<Directory Id=`"$dirId`" Name=`"$name`">")
      foreach ($line in (EmitDirectory $dir.FullName ($Indent + 2))) { $xml.Add($line) }
      $xml.Add("$indentText</Directory>")
    }
    return $xml
  }

  $payloadXml = EmitDirectory $payload 8
  $featureRefs = ($componentRefs | ForEach-Object { "      <ComponentRef Id=`"$_`" />" }) -join "`n"
  $normalizedVersion = if ($Version -match '^(\d+\.\d+\.\d+)') { $Matches[1] } else { '1.0.0' }
  $wxsPath = Join-Path $work 'Jarela.wxs'
  $payloadBlock = $payloadXml -join "`n"
  $wxs = @"
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Id="com.circuitwall.jarela" Name="Jarela" Manufacturer="CircuitWall" Version="$normalizedVersion" UpgradeCode="7bb699df-1373-4fe4-b3c5-f04ed991258b" Scope="perMachine">
    <MajorUpgrade DowngradeErrorMessage="A newer version of Jarela is already installed." />
    <MediaTemplate EmbedCab="yes" />
    <StandardDirectory Id="ProgramFilesFolder">
      <Directory Id="INSTALLFOLDER" Name="Jarela">
$payloadBlock
      </Directory>
    </StandardDirectory>
    <StandardDirectory Id="ProgramMenuFolder">
      <Directory Id="ApplicationProgramsFolder" Name="Jarela">
        <Component Id="StartMenuShortcuts" Guid="*">
          <Shortcut Id="StartMenuShortcut" Name="Jarela" Target="[INSTALLFOLDER]jarela.cmd" Arguments="start" WorkingDirectory="INSTALLFOLDER" />
          <RemoveFolder Id="ApplicationProgramsFolder" On="uninstall" />
          <RegistryValue Root="HKCU" Key="Software\CircuitWall\Jarela" Name="installed" Type="integer" Value="1" KeyPath="yes" />
        </Component>
      </Directory>
    </StandardDirectory>
    <Feature Id="Main" Title="Jarela" Level="1">
$featureRefs
      <ComponentRef Id="StartMenuShortcuts" />
    </Feature>
  </Package>
</Wix>
"@
  [System.IO.File]::WriteAllText($wxsPath, $wxs, [System.Text.UTF8Encoding]::new($false))

  $msiPath = Join-Path $outFull "jarela-$Version-win.msi"
  & $wix.Source build $wxsPath -o $msiPath
  if ($LASTEXITCODE -ne 0) { throw "wix build failed with exit code $LASTEXITCODE" }
  if (-not (Test-Path -LiteralPath $msiPath)) { throw "wix build did not create $msiPath" }
  Write-Host "native Windows package written to $msiPath"
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}