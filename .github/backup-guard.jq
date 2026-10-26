# old and new results-backup envelopes ($o, $n) -> how many reasons to keep the old one
if $o[0].keyId != $n[0].keyId then 0
else
  ($o[0].counts // {}) as $oc | ($n[0].counts // {}) as $nc
  | [$oc | keys[] | select($nc[.] != null)] as $both
  | ([$both[] | $oc[.]] | add // 0) as $ot | ([$both[] | $nc[.]] | add // 0) as $nt
  | [$both[] | select(($oc[.] - $nc[.]) > 20 and $nc[.] < 0.9 * $oc[.])] as $wiped
  | ($wiped | length) + (if $nt < $ot then 1 else 0 end)
end
