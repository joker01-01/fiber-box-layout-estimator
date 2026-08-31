[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
    [string[]] $InputPath,

    [string] $OutputDirectory,

    [string] $OdaPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Find-OdaFileConverter {
    param([string] $RequestedPath)

    $candidates = @()
    if ($RequestedPath) { $candidates += $RequestedPath }
    if ($env:ODA_FILE_CONVERTER) { $candidates += $env:ODA_FILE_CONVERTER }
    $candidates += @(
        'D:\cad-tools\ODAFileConverter\ODAFileConverter.exe',
        'C:\Program Files\ODA\ODAFileConverter\ODAFileConverter.exe',
        'C:\Program Files\ODAFileConverter\ODAFileConverter.exe'
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    $odaRoot = 'C:\Program Files\ODA'
    if (Test-Path -LiteralPath $odaRoot -PathType Container) {
        $installed = Get-ChildItem -LiteralPath $odaRoot -Filter 'ODAFileConverter.exe' -File -Recurse -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($installed) { return $installed.FullName }
    }

    throw 'ODA File Converter was not found. Install it, pass -OdaPath, or set ODA_FILE_CONVERTER.'
}

function Quote-ProcessArgument {
    param([string] $Value)
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Get-AvailableDestination {
    param(
        [string] $Directory,
        [string] $BaseName
    )

    $candidate = Join-Path $Directory ($BaseName + '.dxf')
    if (-not (Test-Path -LiteralPath $candidate)) { return $candidate }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $index = 1
    do {
        $suffix = if ($index -eq 1) { $stamp } else { $stamp + '-' + $index }
        $candidate = Join-Path $Directory ($BaseName + '-' + $suffix + '.dxf')
        $index++
    } while (Test-Path -LiteralPath $candidate)
    return $candidate
}

$odaExe = Find-OdaFileConverter -RequestedPath $OdaPath
$resolvedInputs = foreach ($path in $InputPath) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "DWG file does not exist: $path"
    }
    $resolved = (Resolve-Path -LiteralPath $path).Path
    if ([IO.Path]::GetExtension($resolved) -ine '.dwg') {
        throw "Only DWG input is supported: $resolved"
    }
    $resolved
}

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$workRoot = Join-Path $tempBase ('fiber-dwg-convert-' + [Guid]::NewGuid().ToString('N'))
$workFull = [IO.Path]::GetFullPath($workRoot)
if (-not $workFull.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -or $workFull -eq $tempBase) {
    throw "Temporary directory validation failed: $workFull"
}

$outputs = @()
New-Item -ItemType Directory -Path $workFull | Out-Null
try {
    foreach ($source in $resolvedInputs) {
        $jobRoot = Join-Path $workFull ([Guid]::NewGuid().ToString('N'))
        $sourceDir = Join-Path $jobRoot 'input'
        $convertedDir = Join-Path $jobRoot 'output'
        New-Item -ItemType Directory -Path $sourceDir, $convertedDir | Out-Null
        Copy-Item -LiteralPath $source -Destination (Join-Path $sourceDir ([IO.Path]::GetFileName($source)))

        $arguments = @(
            (Quote-ProcessArgument $sourceDir),
            (Quote-ProcessArgument $convertedDir),
            'ACAD2018',
            'DXF',
            '0',
            '1',
            '"*.dwg"'
        )
        $process = Start-Process -FilePath $odaExe -ArgumentList $arguments -PassThru -Wait -WindowStyle Hidden
        if ($process.ExitCode -ne 0) {
            throw "ODA conversion failed (exit code $($process.ExitCode)): $source"
        }

        $converted = $null
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        do {
            $converted = Get-ChildItem -LiteralPath $convertedDir -Filter '*.dxf' -File -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if (-not $converted) { Start-Sleep -Milliseconds 200 }
        } while (-not $converted -and [DateTime]::UtcNow -lt $deadline)
        if (-not $converted) {
            throw "ODA did not generate a DXF file: $source"
        }

        $targetDir = if ($OutputDirectory) {
            [IO.Path]::GetFullPath($OutputDirectory)
        } else {
            Join-Path ([IO.Path]::GetDirectoryName($source)) 'DXF-output'
        }
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        $destination = Get-AvailableDestination -Directory $targetDir -BaseName ([IO.Path]::GetFileNameWithoutExtension($source))
        Copy-Item -LiteralPath $converted.FullName -Destination $destination
        $outputs += (Resolve-Path -LiteralPath $destination).Path
    }
} finally {
    if (Test-Path -LiteralPath $workFull -PathType Container) {
        Remove-Item -LiteralPath $workFull -Recurse -Force
    }
}

Write-Host ''
Write-Host 'Conversion completed. Import the following DXF file into the browser tool:' -ForegroundColor Green
$outputs | ForEach-Object { Write-Host $_ }
