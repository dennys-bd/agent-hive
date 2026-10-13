# Agent Hive (#259): the user's .zprofile with the user's ZDOTDIR; see .zshenv.
ZDOTDIR=${HIVE_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zprofile ]] && source "$ZDOTDIR/.zprofile"
ZDOTDIR=$HIVE_SHELL_DIR/zsh
