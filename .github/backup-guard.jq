# old and new results-backup envelopes ($o, $n) -> how many reasons to keep the old one.
# The same rule under a new key: a server that changed keys and read the old
# snapshot carries every record over, so only one that started empty loses them.
($o[0].counts // {}) as $oc | ($n[0].counts // {}) as $nc
| [$oc | keys[] | select($nc[.] != null)] as $both
| ([$both[] | $oc[.]] | add // 0) as $ot | ([$both[] | $nc[.]] | add // 0) as $nt
| [$both[] | select(($oc[.] - $nc[.]) > 20 and $nc[.] < 0.9 * $oc[.])] as $wiped
| ($wiped | length) + (if $nt < $ot then 1 else 0 end)
