# Agent Hive (#259): a Hive terminal starts zsh with ZDOTDIR here, so the agents' functions at the end of .zshrc come after the user's own
# files. Each file here runs the user's file of the same name with the user's ZDOTDIR ($HIVE_USER_ZDOTDIR, else $HOME), as zsh would have,
# then points ZDOTDIR back here for the next one. Rewritten on every boot: an edit here is lost.
ZDOTDIR=${HIVE_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zshenv ]] && source "$ZDOTDIR/.zshenv"
# A .zshenv that sets ZDOTDIR moves where the user's other files are, and what ZDOTDIR is once the shell is up
[[ $ZDOTDIR == "${HIVE_USER_ZDOTDIR:-$HOME}" ]] || HIVE_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$HIVE_SHELL_DIR/zsh
