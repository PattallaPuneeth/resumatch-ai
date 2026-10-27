# One-time local setup: creates .env from .env.example with freshly generated secrets.
# Provider keys (Gemini, Groq, OpenRouter, Firecrawl) stay empty, so the stack runs LLM-off
# and match scores come from the ML pipeline only.
#
# Usage: .\scripts\bootstrap.ps1            # then: docker compose up --build
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

if (Test-Path .env) {
    Write-Host '.env already exists; leaving it untouched.'
    Write-Host 'Delete it first if you want fresh secrets.'
    exit 0
}

function New-RandomHex {
    # 32 random bytes as 64 hex chars from the OS CSPRNG
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

$jwtSecret = New-RandomHex
$internalToken = New-RandomHex

$lines = Get-Content .env.example | ForEach-Object {
    if ($_ -match '^JWT_SECRET=') { "JWT_SECRET=$jwtSecret" }
    elseif ($_ -match '^INTERNAL_API_TOKEN=') { "INTERNAL_API_TOKEN=$internalToken" }
    else { $_ }
}
# UTF-8 without BOM so docker compose and Node read the first key correctly
[System.IO.File]::WriteAllLines((Join-Path (Get-Location) '.env'), $lines, (New-Object System.Text.UTF8Encoding $false))

Write-Host 'Created .env with a new JWT_SECRET and INTERNAL_API_TOKEN (LLM provider keys left empty).'
Write-Host 'Next: docker compose up --build'
