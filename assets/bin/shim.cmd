@echo off
rem Agent Hive (#645): the .cmd twin of the agent's POSIX shim beside it, for a program that starts the agent by name outside a Hive
rem PowerShell (cmd.exe, a child process, an editor task) and finds it through PATHEXT. It runs the POSIX shim under Git's sh.exe, the one
rem script that registers the session; MSYS2_ARG_CONV_EXCL keeps MSYS from rewriting an argument that looks like a POSIX path, which the
rem Hive's own pty env sets but a process started outside it lacks. Its last line's exit code is the shim's. Rewritten on every boot.
rem Known ceiling: cmd.exe re-reads %*, so an argument carrying " with &, |, <, > or ^ from a program that starts the agent by name
rem can break out (the BatBadBut class); the Hive's PowerShell function runs the shim under sh.exe and never goes through cmd.exe.
setlocal EnableExtensions DisableDelayedExpansion
set MSYS2_ARG_CONV_EXCL=*
"__HIVE_SH__" "%~dp0__HIVE_COMMAND__" %*
