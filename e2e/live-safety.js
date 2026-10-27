// What the live recorder and the live smoke may send to the real site. Every
// POST there writes something (settle logs a line bet on first sight, slip
// grading adds esports legs to their record, push and auth make records), so
// none are sent: the browser refuses them before they leave.
'use strict';
module.exports = { READ_ONLY_POSTS: [] };
