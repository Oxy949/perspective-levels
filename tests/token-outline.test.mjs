import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createTokenOutlineFilter } from "../scripts/modules/token-outline.js";

class OutlineFilter {
  static create(uniforms) { return new this(this._createFragmentShader(), uniforms); }
  constructor(fragment, uniforms) { this.fragment = fragment; this.uniforms = uniforms; }
}

function installFilterBase() {
  globalThis.foundry = { canvas: { rendering: { filters: { OutlineOverlayFilter: OutlineFilter } } } };
  globalThis.CONST = { CANVAS_PERFORMANCE_MODES: { LOW: 0, MED: 1, HIGH: 2 } };
  globalThis.canvas = { performance: { mode: 2 } };
}

test("alpha-safe outlines reuse their shader class and keep native zoom/thickness handling", () => {
  installFilterBase();
  const a = createTokenOutlineFilter(), b = createTokenOutlineFilter();
  assert.ok(a instanceof OutlineFilter);
  assert.equal(a.constructor, b.constructor);
  assert.notEqual(a, b);
  assert.notEqual(a.uniforms, b.uniforms);
  assert.equal(a.animated, false);
  assert.equal(a.thickness, 3);
  delete foundry.canvas.rendering;
  assert.equal(createTokenOutlineFilter(), null);
});

// Run with PERSPECTIVE_WEBGL_BROWSER set to a Chromium/Chrome/Edge executable.
// Real WebGL checks are optional so the regular suite needs only Node.js.
test("WebGL preserves hidden/drag/fade alpha and draws the contour at every quality", {
  skip: !process.env.PERSPECTIVE_WEBGL_BROWSER,
  timeout: 45000
}, async () => {
  installFilterBase();
  const fragments = [0, 1, 2].map(mode => {
    canvas.performance.mode = mode;
    return createTokenOutlineFilter().fragment;
  });
  const directory = await mkdtemp(join(tmpdir(), "perspective-outline-"));
  try {
    const page = join(directory, "check.html");
    await writeFile(page, `<html><body><script>(${checkWebGL})(${JSON.stringify(fragments)})</script></body></html>`);
    const { stdout } = await promisify(execFile)(process.env.PERSPECTIVE_WEBGL_BROWSER, [
      "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      "--use-angle=swiftshader", "--enable-unsafe-swiftshader", `--user-data-dir=${join(directory, "profile")}`,
      "--dump-dom", pathToFileURL(page).href
    ], { timeout: 35000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    const result = stdout.match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
    assert.ok(result, "Browser did not return the WebGL result");
    assert.deepEqual(JSON.parse(result), { ok: true, renders: 72 });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function checkWebGL(fragments) {
  const finish = value => {
    document.body.innerHTML = "";
    const out = document.createElement("pre"); out.id = "result";
    out.textContent = JSON.stringify(value); document.body.append(out);
  };
  try {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 32;
    const gl = canvas.getContext("webgl", { antialias: false });
    if (!gl) throw new Error("WebGL unavailable");
    const require = (value, message) => { if (!value) throw new Error(message); };
    const shader = (type, source) => {
      const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
      require(gl.getShaderParameter(shader, gl.COMPILE_STATUS), gl.getShaderInfoLog(shader)); return shader;
    };
    const vertex = shader(gl.VERTEX_SHADER, `attribute vec2 position; varying vec2 vTextureCoord;
      void main() { vTextureCoord = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }`);
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const texture = () => {
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    };
    const target = texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 32, 32, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const framebuffer = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    require(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, "Framebuffer incomplete");
    const input = texture();
    let renders = 0;
    for (const fragment of fragments) {
      const program = gl.createProgram(); gl.attachShader(program, vertex);
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER, "precision highp float;\n" + fragment));
      gl.linkProgram(program); require(gl.getProgramParameter(program, gl.LINK_STATUS), gl.getProgramInfoLog(program));
      gl.useProgram(program);
      const position = gl.getAttribLocation(program, "position"); gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1i(gl.getUniformLocation(program, "uSampler"), 0);
      gl.uniform4f(gl.getUniformLocation(program, "filterClamp"), 0.5 / 32, 0.5 / 32, 31.5 / 32, 31.5 / 32);
      gl.uniform2f(gl.getUniformLocation(program, "thickness"), 3 / 32, 3 / 32);
      gl.uniform4f(gl.getUniformLocation(program, "outlineColor"), 0, 1, 0, 1);
      // Includes native drag alpha (0.8 / 0.4), hidden and combined alpha,
      // nearly transparent art, and a complete animation fade through zero.
      for (const opacity of [1, 0.8, 0.5, 0.4, 0.2, 0.01, 1 / 255,
        ...Array.from({ length: 17 }, (_, i) => i / 16)]) {
        const alpha = Math.round(opacity * 255), pixels = new Uint8Array(32 * 32 * 4);
        for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) {
          pixels.set([Math.round(alpha * 0.75), 0, Math.round(alpha * 0.25), alpha], (y * 32 + x) * 4);
        }
        gl.bindTexture(gl.TEXTURE_2D, input);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 32, 32, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        const output = new Uint8Array(pixels.length); gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, output);
        require(gl.getError() === gl.NO_ERROR, "WebGL render failed");
        const center = (16 * 32 + 16) * 4, contour = (16 * 32 + 6) * 4;
        for (let c = 0; c < 4; c++) require(Math.abs(output[center + c] - pixels[center + c]) <= 1,
          `Art changed at opacity ${opacity}, channel ${c}`);
        require(Math.abs(output[contour + 3] - alpha) <= 1, `Contour disappeared at opacity ${opacity}`);
        require(Math.abs(output[contour + 1] - alpha) <= 1, "Contour disposition color changed");
        require(output[3] === 0, "Contour leaked beyond its radius");
        for (let i = 0; i < output.length; i += 4) {
          require(output[i + 3] <= alpha + 1, "Filter increased token opacity");
          for (let c = 0; c < 3; c++) require(output[i + c] <= output[i + 3] + 1, "Invalid premultiplied color");
        }
        renders++;
      }
      gl.deleteProgram(program);
    }
    finish({ ok: true, renders });
  } catch (error) { finish({ ok: false, error: error.message }); }
}
