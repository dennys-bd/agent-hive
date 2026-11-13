# Agent Hive (#259): a Hive terminal starts fish with -C sourcing this, which fish runs after the user's config files; the agents' functions
# win over whatever PATH they set. Rewritten on every boot: an edit here is lost.
# #800: the command shims back first on PATH: fish runs this after the user's config, which may have put others before them
set -gx PATH __HIVE_COMMAND_SHIMS__ $PATH
__HIVE_FUNCTIONS__
