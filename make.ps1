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
    'install-task'   = 'Install the per-user Windows scheduled task (auto-start at logon). Add -Boot to start at machine boot (requires elevated shell).'
    'uninstall-task' = 'Remove the Jarela scheduled task and installed files.'
    'start-task'     = 'Start-ScheduledTask -TaskName Jarela.'
    'stop-task'      = 'Stop-ScheduledTask  -TaskName Jarela.'
    'restart-task'   = 'Stop then start the scheduled task.'
    'logs'           = 'Tail the installed-task log file (Ctrl+C to stop).'
    'status'         = 'Show scheduled-task state and listener on :4312.'
    'push'           = 'Push the current branch to the jarela remote.'
    'scan'           = 'Run npm audit + secret scan over the whole tree.'
    'scan-staged'    = 'Run the secret scan over staged files only (used by pre-commit hook).'
    'install-hooks'  = 'Install .git/hooks/pre-commit to run scan-staged.'
    'backup-key'     = 'Print base64 of the at-rest master keyfile so you can store it in a password manager.'
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

function Invoke-Npm([string[]]$NpmArgs) {
    & npm @NpmArgs
    if ($LASTEXITCODE -ne 0) { throw "npm $($NpmArgs -join ' ') failed (exit $LASTEXITCODE)" }
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

    'install'        { Invoke-Npm -NpmArgs @('install') }

    'dev'            { Invoke-Npm -NpmArgs @('run', 'dev') }

    'build'          { Invoke-Npm -NpmArgs @('run', 'build') }

    'start'          { Invoke-Npm -NpmArgs @('start') }

    'lint'           { Invoke-Npm -NpmArgs @('run', 'lint') }

    'test'           { Invoke-Npm -NpmArgs @('run', 'test:live') }

    'test-full'      { Invoke-Npm -NpmArgs @('run', 'test:live:full') }

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
        # The installer (Windows PowerShell 5.1) shells out to `npm run build`,
        # which writes Next's "Compiled with warnings" to stderr even on a
        # successful build. PowerShell 7 with $ErrorActionPreference='Stop'
        # and the default $PSNativeCommandUseErrorActionPreference=$true
        # treats any stderr line as a terminating error. Suppress both
        # purely for this child invocation; LASTEXITCODE is still the
        # source of truth.
        $prevEAP    = $ErrorActionPreference
        $prevNative = $PSNativeCommandUseErrorActionPreference
        try {
          $ErrorActionPreference = 'Continue'
          $PSNativeCommandUseErrorActionPreference = $false
          & powershell -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'scripts\install-to-system.ps1') @Rest
        } finally {
          $ErrorActionPreference = $prevEAP
          $PSNativeCommandUseErrorActionPreference = $prevNative
        }
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

    'scan' {
        Write-Host '=== npm audit (production deps, high+) ===' -ForegroundColor Cyan
        & npm audit --omit=dev --audit-level=high
        $auditExit = $LASTEXITCODE
        Write-Host ''
        Write-Host '=== secret scan (all tracked files) ===' -ForegroundColor Cyan
        & node scripts/scan-secrets.mjs --all
        if ($LASTEXITCODE -ne 0) { throw "secret scan failed (exit $LASTEXITCODE)" }
        if ($auditExit -ne 0) { throw "npm audit reported high/critical issues (exit $auditExit)" }
    }

    'scan-staged' {
        & node scripts/scan-secrets.mjs --staged
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }

    'install-hooks' {
        $hookDir = Join-Path $RepoRoot '.git\hooks'
        if (-not (Test-Path $hookDir)) { throw "no .git/hooks dir - is this a git checkout?" }
        $hookFile = Join-Path $hookDir 'pre-commit'
        $hookBody = @'
#!/bin/sh
# Installed by `make.ps1 install-hooks`. Aborts the commit if any staged
# file looks like it contains a high-value secret (OpenAI/GitHub/Google
# tokens, AWS keys, private key blocks). See scripts/scan-secrets.mjs.
exec node scripts/scan-secrets.mjs --staged
'@
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($hookFile, $hookBody, $utf8NoBom)
        Write-Host "installed pre-commit hook -> $hookFile" -ForegroundColor Green
    }

    'backup-key' {
        $keyPath = Join-Path $env:LOCALAPPDATA 'Jarela\.secret-key'
        if (-not (Test-Path $keyPath)) {
            Write-Host "No keyfile at $keyPath." -ForegroundColor Yellow
            Write-Host "Either the installed app is using the OS keychain (preferred)," -ForegroundColor DarkGray
            Write-Host "or it has not booted yet. Start it once, then re-run this." -ForegroundColor DarkGray
            exit 0
        }
        $bytes = [System.IO.File]::ReadAllBytes($keyPath)
        $b64 = [System.Convert]::ToBase64String($bytes)
        Write-Host '=== Jarela master keyfile (base64) ===' -ForegroundColor Cyan
        Write-Host '' 
        Write-Host $b64
        Write-Host ''
        Write-Host 'Save this string in a password manager. Without it you cannot' -ForegroundColor Yellow
        Write-Host 'decrypt the contents of jarela.db if the host is lost.' -ForegroundColor Yellow
        Write-Host ''
        Write-Host "To restore: write the base64-decoded bytes back to $keyPath" -ForegroundColor DarkGray
        Write-Host '             (32 bytes, mode 0600) and restart the scheduled task.' -ForegroundColor DarkGray
    }

    default {
        Write-Host "Unknown target: $Target" -ForegroundColor Red
        Write-Host ''
        Show-Help
        exit 1
    }
}
