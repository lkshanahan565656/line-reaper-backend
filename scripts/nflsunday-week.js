// The NFL Sunday a run belongs to, as YYYYMMDD: Wednesday to Saturday look
// ahead to the coming Sunday, Sunday is itself, Monday and Tuesday look back.
module.exports = function week(t = Date.now()) {
  const d = new Date(t - 4 * 3600e3);             // US Eastern, near enough
  const day = d.getUTCDay();                      // 0 Sunday
  const shift = day === 0 ? 0 : day <= 2 ? -day : 7 - day;
  return new Date(d.getTime() + shift * 86400e3).toISOString().slice(0, 10).replace(/-/g, '');
};
if (require.main === module) console.log(module.exports());
