# Agent Hive (#259): the user's .zshrc with the user's ZDOTDIR, then the agents' functions, which win over whatever PATH it set; see .zshenv.
ZDOTDIR=${HIVE_USER_ZDOTDIR:-$HOME}
# A system zshrc (macOS /etc/zshrc) ran with ZDOTDIR here and set HISTFILE from it: back to the folder it would have named without the Hive
[[ $HISTFILE == "$HIVE_SHELL_DIR/zsh/.zsh_history" ]] && HISTFILE=$ZDOTDIR/.zsh_history
[[ -f $ZDOTDIR/.zshrc ]] && source "$ZDOTDIR/.zshrc"
ZDOTDIR=$HIVE_SHELL_DIR/zsh
__HIVE_FUNCTIONS__
# The last file a non-login shell reads: the user's ZDOTDIR back, unset when it was; a login shell's .zlogin does it
if [[ ! -o login ]]; then
  if [[ -n $HIVE_USER_ZDOTDIR ]]; then ZDOTDIR=$HIVE_USER_ZDOTDIR; else unset ZDOTDIR; fi
  unset HIVE_USER_ZDOTDIR
fi
