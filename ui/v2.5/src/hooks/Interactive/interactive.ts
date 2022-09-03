import Handy from "thehandy";
import {
  HandyMode,
  HsspSetupResult,
  CsvUploadResponse,
  HandyFirmwareStatus,
} from "thehandy/lib/types";
import { KnockRod, ShockRodSize } from "./knockRod";
import { KnockRodState } from "./knockRodState";
import sortedIndexBy from "lodash.sortedindexby";

interface IFunscript {
  actions: Array<IAction>;
  inverted?: boolean;
  range: number;
}

interface IAction {
  at: number;
  pos: number;
}

// Utility function to convert one range of values to another
function convertRange(
  value: number,
  fromLow: number,
  fromHigh: number,
  toLow: number,
  toHigh: number
) {
  return ((value - fromLow) * (toHigh - toLow)) / (fromHigh - fromLow) + toLow;
}

// Converting to CSV first instead of uploading Funscripts is required
// Reference for Funscript format:
// https://pkg.go.dev/github.com/funjack/launchcontrol/protocol/funscript
function convertFunscriptToCSV(funscript: IFunscript) {
  const lineTerminator = "\r\n";
  if (funscript?.actions?.length > 0) {
    return funscript.actions.reduce((prev: string, curr: IAction) => {
      var { pos } = curr;
      // If it's inverted in the Funscript, we flip it because
      // the Handy doesn't have inverted support
      if (funscript.inverted === true) {
        pos = convertRange(curr.pos, 0, 100, 100, 0);
      }
      // in APIv2; the Handy maintains it's own slide range
      // (ref: https://staging.handyfeeling.com/api/handy/v2/docs/#/SLIDE )
      // so if a range is specified in the Funscript, we convert it to the
      // full range and let the Handy's settings take precedence
      if (funscript.range) {
        pos = convertRange(curr.pos, 0, funscript.range, 0, 100);
      }
      return `${prev}${curr.at},${pos}${lineTerminator}`;
    }, `#Created by stash.app ${new Date().toUTCString()}\n`);
  }
  throw new Error("Not a valid funscript");
}

// copied from https://github.com/defucilis/thehandy/blob/main/src/HandyUtils.ts
// since HandyUtils is not exported.
// License is listed as MIT. No copyright notice is provided in original.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
async function uploadCsv(
  csv: File,
  filename?: string
): Promise<CsvUploadResponse> {
  const url = "https://www.handyfeeling.com/api/sync/upload?local=true";
  if (!filename) filename = "script_" + new Date().valueOf() + ".csv";
  const formData = new FormData();
  formData.append("syncFile", csv, filename);
  const response = await fetch(url, {
    method: "post",
    body: formData,
  });
  const newUrl = await response.json();
  return newUrl;
}

// Interactive currently uses the Handy API, but could be expanded to use buttplug.io
// via buttplugio/buttplug-rs-ffi's WASM module.
export class Interactive {
  _connected: boolean;
  _playing: boolean;
  _scriptOffset: number;
  _handy: Handy;

  constructor(handyKey: string, scriptOffset: number) {
    this._handy = new Handy();
    this._handy.connectionKey = handyKey;
    this._scriptOffset = scriptOffset;
    this._connected = false;
    this._playing = false;
  }

  async connect() {
    const connected = await this._handy.getConnected();
    if (!connected) {
      throw new Error("Handy not connected");
    }

    // check the firmware and make sure it's compatible
    const info = await this._handy.getInfo();
    if (info.fwStatus === HandyFirmwareStatus.updateRequired) {
      throw new Error("Handy firmware update required");
    }
  }

  set handyKey(key: string) {
    this._handy.connectionKey = key;
  }

  get handyKey(): string {
    return this._handy.connectionKey;
  }

  set scriptOffset(offset: number) {
    this._scriptOffset = offset;
  }

  async uploadScript(funscriptPath: string) {
    console.info("uploading scripts");

    try {
      await this.uploadScriptKnockRod(funscriptPath);
    } catch (e) {
      console.error("coud not connect to knockrod...", e);
    }

    if (!(this._handy.connectionKey && funscriptPath)) {
      return;
    }

    const csv = await fetch(funscriptPath)
      .then((response) => response.json())
      .then((json) => convertFunscriptToCSV(json));
    const fileName = `${Math.round(Math.random() * 100000000)}.csv`;
    const csvFile = new File([csv], fileName);

    const tempURL = await uploadCsv(csvFile).then((response) => response.url);

    await this._handy.setMode(HandyMode.hssp);

    this._connected = await this._handy
      .setHsspSetup(tempURL)
      .then((result) => result === HsspSetupResult.downloaded);
  }

  async sync() {
    return this._handy.getServerTimeOffset();
  }

  setServerTimeOffset(offset: number) {
    this._handy.estimatedServerTimeOffset = offset;
  }

  async play(atSeconds: number, playbackRate: number) {
    if (this._knockRod) {
      await this.playKnockRod(atSeconds, playbackRate);
    }

    if (!this._connected) {
      return;
    }

    this._playing = await this._handy
      .setHsspPlay(
        Math.round(atSeconds * 1000 + this._scriptOffset),
        this._handy.estimatedServerTimeOffset + Date.now() // our guess of the Handy server's UNIX epoch time
      )
      .then(() => true);
  }

  async pause() {
    if (this._pendingKnockRodTick) {
      clearTimeout(this._pendingKnockRodTick);
    }
    this._knockRodPlaying = false;

    if (!this._connected) {
      return;
    }
    this._playing = await this._handy.setHsspStop().then(() => false);
  }

  async ensurePlaying(position: number, playbackRate: number) {
    if (this._playing) {
      return;
    }
    await this.play(position, playbackRate);
  }

  async setLooping(looping: boolean) {
    if (!this._connected) {
      return;
    }
    this._handy.setHsspLoop(looping);
  }

  async uploadScriptKnockRod(funscriptPath: string) {
    const json = await fetch(funscriptPath).then((response) => response.json());
    console.info("json:", json);
    this._script = json;
    if (this._script?.inverted !== undefined) {
      this._knockRodInvert = !this._script.inverted; // double invert
    }

    if (this._knockRod) {
      await this._knockRod.moveRetract();
      console.info("loading json");
    }
    if (!this._knockRod) {
      this._knockRod = await this.connectKnockRod();
    }
  }

  setKnockRodParams(params: { min: number; max: number; smoothness: number }) {
    this._knockRodParams = { ...params };
  }

  static interpolate(a: number, b: number, frac: number): number {
    // points A and B, frac 0..1
    return a + (b - a) * frac;
  }
  static interpolateAction(a: IAction, b: IAction, at: number): IAction {
    const frac = (at - a.at) / b.at;
    return {
      pos: Interactive.interpolate(a.pos, b.pos, frac),
      at: Interactive.interpolate(a.at, b.at, frac),
    };
  }

  private async connectKnockRod(): Promise<KnockRod> {
    const ports = await window.navigator.serial.getPorts();
    const port =
      ports.length === 0
        ? await window.navigator.serial.requestPort({})
        : ports[0];
    const t = new KnockRod(port, ShockRodSize.EightInch);
    t.addEventListener("stateChange", (e) => {
      this._knockRodState = e.detail.state;
    });
    await t.init();
    console.info("Rod initialized");
    return t;
  }

  findIndexBefore(at: number) {
    return sortedIndexBy(this._script?.actions, { at, pos: 0 }, "at");
  }

  async dispose() {
    console.info("disposing client");
    this._playing = false;
    if (this._pendingKnockRodTick) {
      clearTimeout(this._pendingKnockRodTick);
    }
    if (this._knockRod) {
      await this._knockRod.setServo(false);
      await this._knockRod.dispose();
    }
    console.info("disposed");
  }

  async playKnockRod(atSeconds: number, playbackRate: number) {
    if (!this._script) {
      return;
    }

    this._playbackRate = playbackRate;
    const at = Math.floor(atSeconds * 1000) + this._scriptOffset;
    clearTimeout(this._pendingKnockRodTick);

    this._knockRodPlaying = true;

    const nextIndex = Math.max(this.findIndexBefore(at));
    const nextAction = this._script!.actions[nextIndex];
    this._currentIndex = nextIndex - 1;
    const previousAction = this._script!.actions[this._currentIndex] || {
      at: 0,
      pos: nextAction.pos,
    };

    this._currentAction =
      at < previousAction.at
        ? { at: 0, pos: 0 }
        : Interactive.interpolateAction(previousAction, nextAction, at);

    this.tick();
  }

  tick() {
    if (!this._playing) {
      return;
    }
    const next = this._script?.actions[this._currentIndex + 1] || undefined;
    const from = this._currentAction
      ? this._currentAction
      : { at: 0, pos: this._knockRodInvert ? 100 : 0 };
    const to = next || { at: from.at + 1000, pos: from.pos };

    const minDepth = this._knockRodParams.min;
    const maxDepth = this._knockRodParams.max;
    const posPercent = this._knockRodInvert
      ? (100 - from.pos) / 100.0
      : from.pos / 100.0;
    const nextposPercent = this._knockRodInvert
      ? (100 - to.pos) / 100.0
      : to.pos / 100.0;

    const posMillis = Interactive.interpolate(minDepth, maxDepth, posPercent);
    const nextPosMillis = Interactive.interpolate(
      minDepth,
      maxDepth,
      nextposPercent
    );
    const deltaT = Math.floor((to.at - from.at) / this._playbackRate);

    const deltaS = Math.abs(nextPosMillis - posMillis);
    const velocity = Math.round((deltaS / deltaT) * 1000.0);
    const velocityCapped = Math.max(500, Math.min(35000, Math.round(velocity)));

    if (this._knockRod) {
      this._knockRod!.moveTo(
        nextPosMillis,
        velocityCapped,
        this._knockRodParams.smoothness
      );
    } else {
      console.info(
        `simulating move to: ${nextPosMillis} ${velocity} ${this._knockRodParams.smoothness}`
      );
    }

    this._pendingKnockRodTick = setTimeout(() => {
      this._currentIndex++;
      this._currentAction = this._script?.actions[this._currentIndex];
      //console.info("scheduled index ", this._currentIndex, this._currentAction)
      if (this._currentAction) {
        // if there is a next tick
        this.tick();
      }
    }, deltaT);
  }

  private _currentIndex: number = -1;
  private _currentAction: IAction | undefined = { pos: 0, at: 0 };
  private _knockRodInvert: boolean = true;

  private _knockRodParams: { min: number; max: number; smoothness: number } = {
    min: 2000,
    max: 16000,
    smoothness: 30,
  };
  private _knockRodPlaying: boolean = false;

  private _pendingKnockRodTick: any;
  private _playbackRate: number = 1;

  private _script: IFunscript | undefined;
  private _knockRodState: KnockRodState | undefined;
  private _knockRod: KnockRod | undefined;
}
