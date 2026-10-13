# Agent Hive (#259): the user's .zlogin with the user's ZDOTDIR; the last file a login shell reads, so the user's ZDOTDIR comes back here,
# unset when it was. See .zshenv.
ZDOTDIR=${HIVE_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zlogin ]] && source "$ZDOTDIR/.zlogin"
if [[ -n $HIVE_USER_ZDOTDIR ]]; then ZDOTDIR=$HIVE_USER_ZDOTDIR; else unset ZDOTDIR; fi
unset HIVE_USER_ZDOTDIR
