param([string]$SinceUtc)
# Read-only metadata projection. Never print Event.Message, XML, paths or dumps.
function ConvertTo-SafeApplicationFailure {
    param($EventRecord)
    [xml]$eventXml = $EventRecord.ToXml()
    $fields = @{}
    foreach ($entry in $eventXml.Event.EventData.Data) { $fields[[string]$entry.Name] = [string]$entry.'#text' }
    function SafeBasename([string]$value) {
        $name = ($value -split '[/\\]')[-1]
        if ($name -match '^[a-zA-Z0-9_.-]{1,160}$') { return $name }
        return $null
    }
    function SafeValue([string]$value, [string]$pattern) {
        if ($value -match $pattern) { return $value }
        return $null
    }
    $application = SafeBasename $fields.AppName
    if ($application -ne 'node.exe') { return $null }
    [ordered]@{
        event = 'application-error'; eventId = 1000
        eventTimeUtc = $EventRecord.TimeCreated.ToUniversalTime().ToString('o')
        application = $application
        applicationVersion = SafeValue $fields.AppVersion '^[0-9.]{1,40}$'
        module = SafeBasename $fields.ModuleName
        moduleVersion = SafeValue $fields.ModuleVersion '^[0-9.]{1,40}$'
        exceptionCode = SafeValue $fields.ExceptionCode '^(0x)?[a-fA-F0-9]{1,16}$'
        faultingOffset = SafeValue $fields.FaultingOffset '^(0x)?[a-fA-F0-9]{1,16}$'
        processId = SafeValue $fields.ProcessId '^(0x)?[a-fA-F0-9]{1,16}$'
        processCreationTime = SafeValue $fields.ProcessCreationTime '^(0x)?[a-fA-F0-9]{1,32}$'
        fastFailParameter = 'unavailable'
        correlation = 'time-window-only; compare PID and creation time with worker lifetime'
    }
}
if ($MyInvocation.InvocationName -ne '.') {
    try {
        $start = [DateTimeOffset]::Parse($SinceUtc).UtcDateTime
        $records = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Error'; Id = 1000; StartTime = $start } -ErrorAction Stop)
        $count = 0
        foreach ($record in $records) {
            $safe = ConvertTo-SafeApplicationFailure $record
            if ($null -ne $safe) {
                Write-Output ('[windows-test-failure-metadata] ' + (ConvertTo-Json -InputObject $safe -Compress))
                $count += 1
            }
        }
        if ($count -eq 0) { Write-Output '[windows-test-failure-metadata] {"event":"no-matching-event","cause":"undetermined","fastFailParameter":"unavailable"}' }
    } catch {
        # Access denied, unavailable log and no-event results are not test failures.
        # Exception text can contain machine paths; emit only a fixed classification.
        $status = if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { 'no-matching-event' } else { 'metadata-unavailable' }
        Write-Output ('[windows-test-failure-metadata] {"event":"' + $status + '","cause":"undetermined","fastFailParameter":"unavailable"}')
    }
}
