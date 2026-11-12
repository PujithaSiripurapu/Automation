# Registers (or replaces) a Windows scheduled task that runs the Pest Control
# book-and-cancel test every 5 minutes while this user is logged on.
#
#   Install:   powershell -ExecutionPolicy Bypass -File scripts\schedule-pest-book-cancel.ps1
#   Remove:    powershell -ExecutionPolicy Bypass -File scripts\schedule-pest-book-cancel.ps1 -Remove
#   Run now:   Start-ScheduledTask -TaskName "UtilStop Pest Book-Cancel"
#   Results:   logs\pest-book-cancel.log   (latest HTML report: playwright-report\index.html)

param([switch]$Remove)

$taskName = 'UtilStop Pest Book-Cancel'

if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "Removed scheduled task '$taskName'."
    return
}

$launcher = Join-Path $PSScriptRoot 'run-hidden.vbs'
$action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$launcher`"" -WorkingDirectory (Split-Path $PSScriptRoot)
$trigger  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
              -RepetitionInterval (New-TimeSpan -Minutes 5)
# Skip a run if the previous one is still going; kill a hung run after 10 minutes.
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
              -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
              -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Playwright: book Pest Control on dev.utilstop.com for a future date, then cancel it.' -Force | Out-Null

Write-Output "Scheduled '$taskName' every 5 minutes (first run at $((Get-Date).AddMinutes(1).ToString('HH:mm')))."
