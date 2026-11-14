# Agent Hive (#645): a Hive terminal on Windows starts PowerShell with -NoProfile and dot-sources this file as a scriptblock, which
# execution policy, applying to script files only, never stops. It runs the user's own profiles first, in PowerShell's order and under
# the user's own policy, then points PSReadLine at the terminal's own history, then puts the command shims' folder and the shim folder back
# first on PATH (#806: a profile that prepends nvm would hide the command shim, #800 decision 18) and defines a function per agent, which
# wins over whatever PATH those profiles set; an alias of that name, which would beat the function, is removed first. Rewritten on every boot: an edit here is lost.
foreach ($hive_profile in @($PROFILE.AllUsersAllHosts, $PROFILE.AllUsersCurrentHost, $PROFILE.CurrentUserAllHosts, $PROFILE.CurrentUserCurrentHost)) {
  if ($hive_profile -and (Test-Path -LiteralPath $hive_profile)) { . $hive_profile }
}
Remove-Variable hive_profile
# Without PSReadLine nothing is saved, which is PowerShell's own behaviour
if (Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue) { Set-PSReadLineOption -HistorySavePath $env:HISTFILE }
$env:PATH = __HIVE_COMMAND_SHIMS__ + ';' + __HIVE_BIN__ + ';' + $env:PATH
__HIVE_FUNCTIONS__
