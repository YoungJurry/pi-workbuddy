// Test-process-only network firewall. This file is never loaded by the extension.
import { Socket } from "node:net";
globalThis.fetch = async () => { throw new Error("OFFLINE TEST: unexpected global fetch"); };
Socket.prototype.connect = function () { throw new Error("OFFLINE TEST: unexpected socket connection"); };
