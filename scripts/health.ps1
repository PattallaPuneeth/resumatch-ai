# Prints each compose container's state and health (SPEC section 7.2). Exits 1 if any
# running service with a healthcheck is not healthy.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$status = 0
docker compose ps --all --format '{{.Name}}|{{.State}}|{{.Health}}' | ForEach-Object {
    if (-not $_) { return }
    $name, $state, $health = $_ -split '\|', 3
    $shown = if ($health) { $health } else { 'no healthcheck' }
    '{0,-28} {1,-10} {2}' -f $name, $state, $shown
    if ($state -eq 'running' -and $health -and $health -ne 'healthy') { $script:status = 1 }
}
exit $status
