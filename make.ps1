#requires -Version 5.1
<#
.SYNOPSIS
    Windows task runner for Jarela — Makefile-equivalent for PowerShell.

.DESCRIPTION
    Dispatches the common build/test/run targets without needing GNU Make.

.EXAMPLE
    .\make.ps1 help
    .\make.ps1 dev
    .\make.ps1 build
    .\make.ps1 install-task
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Target = 'help',

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot
Set-Location $RepoRoot

# ---------------------------------------------------------------------------
# Targets
# ---------------------------------------------------------------------------

$Targets = [ordered]@{
    'help'           = 'Show this help.'
    'install'        = 'npm install.'
    'dev'            = 'Hot-reload dev server on http://localhost:3000.'
    'build'          = 'Production build (standalone output).'
    'start'          = 'Serve the standalone build on http://localhost:4312.'
    'lint'           = 'Run eslint.'
    'test'           = 'Live integration smoke tests.'
    'test-full'      = 'Extended live test suite.'
    'icons'          = 'Regenerate the logo / icon set from public\logo-source.png.'
    'clean'          = 'Remove .next, build artefacts, and node_modules cache.'
    'install-task'   = 'Install the per-user Windows scheduled task (auto-start at logon).'
    'uninstall-task' = 'Remove the Jarela scheduled task and installed files.'
    'start-task'     = 'Start-ScheduledTask -TaskName Jarela.'
    'stop-task'      = 'Stop-ScheduledTask  -TaskName Jarela.'
    'restart-task'   = 'Stop then start the scheduled task.'
    'logs'           = 'Tail the installed-task log file (Ctrl+C to stop).'
    'status'         = 'Show scheduled-task state and listener on :4312.'
    'push'           = 'Push the current branch to the jarela remote.'
}

function Show-Help {
    Write-Host "Jarela task runner" -ForegroundColor Cyan
    Write-Host "Usage: .\make.ps1 <target>" -ForegroundColor DarkGray
    Write-Host ''
    foreach ($k in $Targets.Keys) {
        $name = $k.PadRight(16)
        Write-Host "  $name " -ForegroundColor Yellow -NoNewline
        Write-Host $Targets[$k]
    }
    Write-Host ''
    Write-Host "Data dir: $env:USERPROFILE\.jarela" -ForegroundColor DarkGray
    Write-Host "Override with `$env:JARELA_DB_DIR" -ForegroundColor DarkGray
}

function Invoke-Npm([string[]]$Args) {
    & npm @Args
    if ($LASTEXITCODE -ne 0) { throw "npm $($Args -join ' ') failed (exit $LASTEXITCODE)" }
}

function Invoke-Node([string]$Script) {
    & node $Script @Rest
    if ($LASTEXITCODE -ne 0) { throw "node $Script failed (exit $LASTEXITCODE)" }
}

function Get-LogPath { Join-Path $env:LOCALAPPDATA 'Jarela\logs\app.log' }

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

switch ($Target.ToLowerInvariant()) {

    'help'           { Show-Help }

    'install'        { Invoke-Npm @('install') }

    'dev'            { Invoke-Npm @('run', 'dev') }

    'build'          { Invoke-Npm @('run', 'build') }

    'start'          { Invoke-Npm @('start') }

    'lint'           { Invoke-Npm @('run', 'lint') }

    'test'           { Invoke-Npm @('run', 'test:live') }

    'test-full'      { Invoke-Npm @('run', 'test:live:full') }

    'icons'          { Invoke-Node 'scripts\gen-logo.mjs' }

    'clean' {
        foreach ($p in @('.next', 'node_modules\.cache', 'tsconfig.tsbuildinfo')) {
            if (Test-Path $p) {
                Write-Host "removing $p" -ForegroundColor DarkGray
                Remove-Item -Recurse -Force $p
            }
        }
    }

    'install-task' {
        & powershell -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'scripts\install-to-system.ps1') @Rest
        if ($LASTEXITCODE -ne 0) { throw "installer failed (exit $LASTEXITCODE)" }
    }

    'uninstall-task' {
        & powershell -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'scripts\uninstall-from-system.ps1') @Rest
        if ($LASTEXITCODE -ne 0) { throw "uninstaller failed (exit $LASTEXITCODE)" }
    }

    'start-task'     { Start-ScheduledTask -TaskName 'Jarela' }

    'stop-task'      { Stop-ScheduledTask  -TaskName 'Jarela' -ErrorAction SilentlyContinue }

    'restart-task' {
        Stop-ScheduledTask  -TaskName 'Jarela' -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 800
        Start-ScheduledTask -TaskName 'Jarela'
    }

    'logs' {
        $log = Get-LogPath
        if (-not (Test-Path $log)) { throw "log not found: $log (install the task first?)" }
        Get-Content $log -Tail 50 -Wait
    }

    'status' {
        Write-Host '=== Scheduled task ===' -ForegroundColor Cyan
        Get-ScheduledTask -TaskName 'Jarela' -ErrorAction SilentlyContinue |
            Select-Object TaskName, State | Format-Table -AutoSize | Out-String | Write-Host
        Write-Host '=== :4312 listener ===' -ForegroundColor Cyan
        $c = Get-NetTCPConnection -LocalPort 4312 -State Listen -ErrorAction SilentlyContinue
        if ($c) {
            $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
            Write-Host "PID $($c.OwningProcess)  $($proc.ProcessName)  started $($proc.StartTime)"
        } else {
            Write-Host '(nothing listening)'
        }
        Write-Host '=== Data dir ===' -ForegroundColor Cyan
        $dir = if ($env:JARELA_DB_DIR) { $env:JARELA_DB_DIR } else { Join-Path $env:USERPROFILE '.jarela' }
        if (Test-Path $dir) {
            Get-ChildItem $dir -Force | Select-Object Name, Length, LastWriteTime |
                Format-Table -AutoSize | Out-String | Write-Host
        } else {
            Write-Host "$dir does not exist yet"
        }
    }

    'push' {
        $branch = (& git rev-parse --abbrev-ref HEAD).Trim()
        & git push jarela $branch
        if ($LASTEXITCODE -ne 0) { throw "git push failed (exit $LASTEXITCODE)" }
    }

    default {
        Write-Host "Unknown target: $Target" -ForegroundColor Red
        Write-Host ''
        Show-Help
        exit 1
    }
}
