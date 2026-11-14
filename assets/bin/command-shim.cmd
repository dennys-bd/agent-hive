@echo off
rem Agent Hive (#806): the .cmd twin of the command shim beside it, for PowerShell and cmd.exe, which find a command through PATHEXT and
rem never run an extensionless file. It runs the POSIX shim under Git's sh.exe, so one script speaks the semaphore protocol on every OS;
rem MSYS2_ARG_CONV_EXCL keeps MSYS from rewriting an argument that looks like a POSIX path. Its last line's exit code is the shim's.
rem Rewritten on every boot and save. The folder is written whole: cmd.exe resolves %~dp0 against the cwd for a quoted bare name.
rem Known ceiling: cmd.exe re-reads the argument list, so an argument carrying " with &, |, <, > or ^ can break out (the BatBadBut class),
rem as it already can through the real pnpm.cmd this file stands in front of; and cmd.exe expands a % before the shim sees it (#645).
setlocal EnableExtensions DisableDelayedExpansion
set MSYS2_ARG_CONV_EXCL=*
"__HIVE_SH__" "__HIVE_DIR__\__HIVE_COMMAND__" %*
