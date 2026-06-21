"use strict";

const { WxBotAdapter, createWxBotAdapter } = require("./adapter");
const { ControlPlaneClient } = require("./control-plane-client");
const { ILinkClient, textFromIlinkMessage } = require("./ilink-client");

module.exports = {
  ControlPlaneClient,
  ILinkClient,
  WxBotAdapter,
  createWxBotAdapter,
  textFromIlinkMessage
};
