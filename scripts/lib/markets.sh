# The markets we sell into, for the shell lanes that need to scope themselves.
#
# ONE definition, sourced rather than copied: all of Africa (the country set geo.py tags, matching
# the VPS "Africa" market) + JP. ct-tail is TLD-agnostic and lands the whole global CT firehose, so
# a budget-consuming lane without this scope burns its allowance on stores we don't sell to.
#
# Mirrors VISIBLE_MARKETS in lib/markets.ts (27 African codes) plus JP, which the app does not show
# but we do monitor. If you add a market, add it in BOTH — they answer different questions, so they
# are deliberately not derived from each other.
#
#   source "$(dirname "$0")/lib/markets.sh"   # then use "$MARKETS"
MARKETS="AO,BW,CI,CM,DZ,EG,ET,GH,KE,LS,LY,MA,MU,MW,MZ,NA,NG,RW,SN,SO,SZ,TN,TZ,UG,ZA,ZM,ZW,JP"
