const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.env.MUSIC_EDITOR_TEST_DATA);
BrowserWindow.prototype.show = function () {};
require("../electron/main.cjs");
