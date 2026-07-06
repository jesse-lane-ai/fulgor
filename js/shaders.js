// Shader sources for the thunderstorm raymarcher. All world units are kilometers.

const VERT_SRC = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;
out vec4 outColor;

uniform vec2  uResolution;
uniform float uTime;          // simulation time, seconds
uniform vec2  uLook;          // yaw, pitch
uniform float uFovTan;
uniform vec3  uCamPos;
uniform vec3  uSeedOffset;
uniform float uWindSpeed;

uniform vec4  uTowers[8];     // x, z, radius, current top height
uniform int   uNumTowers;
uniform vec3  uBoundsMin;
uniform vec3  uBoundsMax;
uniform vec4  uRain;          // x, z, radius, strength (forward-flank core)
uniform vec4  uShear;         // xy: wind shear dir, z: strength (km), w: unused
uniform vec4  uWall;          // x, z, radius, strength (wall cloud lowering)

uniform float uDensityMul;
uniform float uCoverage;
uniform int   uSteps;
uniform int   uLightSteps;
uniform float uExposure;
uniform int   uHighDetail;

uniform vec4  uFlashPos[3];   // xyz position, w intensity
uniform vec3  uFlashColor[3];
uniform vec3  uFlashAmb;      // scene-wide flicker from active flashes
uniform vec3  uAmbColor;
uniform vec3  uSunColor;
uniform vec3  uSunDir;
uniform float uBgClouds;
uniform float uCirrus;
uniform float uMidClouds;

uniform vec3  uBoltA[48];
uniform vec3  uBoltB[48];
uniform int   uBoltCount;
uniform vec3  uBoltColor;
uniform float uBoltIntensity;

const float CLOUD_BASE = 0.85;
const float SIGMA = 42.0;     // extinction per km at density 1
const float PI = 3.14159265;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  float nx00 = mix(n000, n100, f.x), nx10 = mix(n010, n110, f.x);
  float nx01 = mix(n001, n101, f.x), nx11 = mix(n011, n111, f.x);
  return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z);
}
float fbm5(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.13 + vec3(11.7, 7.3, 5.1); a *= 0.5; }
  return s / 0.96875;
}
float fbm3(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.31 + vec3(5.2, 9.1, 3.7); a *= 0.5; }
  return s / 0.875;
}

// Cumulonimbus silhouette: broad base, slight mid waist, and — only on towers
// tall enough to reach the tropopause — a wide disc anvil flaring at the top.
// Short flanking cumulus stay simple rounded turrets.
float widthProfile(float h, float tall) {
  float w = mix(0.92, 1.0, smoothstep(-0.08, 0.18, h));
  w *= mix(1.0, 0.88, smoothstep(0.25, 0.58, h));
  float flare = 1.0 + 1.35 * smoothstep(0.70, 0.86, h);
  w *= mix(1.0, flare, smoothstep(0.50, 0.90, tall));
  return w;
}

float smax(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0);
  return mix(b, a, h) + k * h * (1.0 - h);
}

float shapeField(vec3 p) {
  float best = -1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= uNumTowers) break;
    vec4 tw = uTowers[i];
    float top = tw.w;
    float hn = (p.y - CLOUD_BASE) / (top - CLOUD_BASE);
    if (hn < -0.05 || hn > 1.30) continue;
    // Wind shear: the updraft tilts downwind and the anvil drifts further.
    // Short flanking towers barely reach the shear layer.
    float tallness = clamp((top - CLOUD_BASE) / 10.0, 0.0, 1.0);
    float drift = (hn * hn * 0.15 + smoothstep(0.70, 0.98, hn) * 0.55) * uShear.z * tallness;
    vec2 off = p.xz - tw.xy - uShear.xy * drift;
    if (hn <= 1.04) {
      float w = widthProfile(hn, tallness);
      // The disc anvil gets an extra push downwind, short on the back-sheared side.
      float sa = smoothstep(0.68, 0.92, hn) * tallness;
      // Forward-flank shelf: the base also stretches downwind so the cloud
      // roofs the precipitation core instead of leaving it detached.
      float sb = (1.0 - smoothstep(0.10, 0.45, hn)) * tallness;
      float u = dot(off, uShear.xy);
      float v = -off.x * uShear.y + off.y * uShear.x;
      float elong = 1.0 + (u > 0.0 ? 0.7 * sa + 0.72 * sb : 0.2 * sa) * uShear.z * 0.22;
      float r = length(vec2(u / elong, v)) / (tw.z * w);
      // Undulate the anvil rim: without this the disc edge is a perfect cone
      // and reads as a razor-straight CG line from below.
      if (sa > 0.01) {
        float wob = vnoise(vec3(p.x * 0.22, p.y * 0.35, p.z * 0.22) + uSeedOffset);
        r *= 1.0 + (wob - 0.5) * 0.5 * sa;
      }
      float vf = smoothstep(-0.04, 0.10, hn) * (1.0 - smoothstep(0.84, 1.03, hn));
      best = smax(best, (1.0 - r) * vf, 0.25);
    }
    // Overshooting top: a dome punching above the anvil on the main updraft.
    if (i == 0 && hn > 0.85) {
      float os = 1.0 - length(vec3(off.x / (tw.z * 0.42), (p.y - top) / 0.95, off.y / (tw.z * 0.42)));
      best = smax(best, os * 0.85, 0.2);
    }
  }
  return best;
}

float cloudDensity(vec3 p, bool detail) {
  float d = 0.0;
  float s = shapeField(p);
  // Wall cloud: a lowered base hanging under the rear of the main updraft.
  // Folded into the same density field as the storm (it boosts the shape and
  // shares the storm's noise) so it always stays attached to the base above.
  float wallM = 0.0;
  if (uWall.w > 0.0 && p.y > 0.40 && p.y < CLOUD_BASE + 0.7) {
    float rw = length(p.xz - uWall.xy) / uWall.z;
    if (rw < 1.0) wallM = (1.0 - rw) * smoothstep(0.38, 0.72, p.y) * uWall.w;
  }
  if (s > 0.01 || wallM > 0.005) {
    vec3 q = p * 0.30 + uSeedOffset;
    q.x += uTime * 0.012 * uWindSpeed;
    q.z += uTime * 0.004 * uWindSpeed;
    // Domain warp for the billowing cauliflower look.
    float wrp = vnoise(q * 2.2 + vec3(3.1, 1.7, 9.2));
    q += (wrp - 0.5) * 0.55;
    float n = fbm5(q + vec3(0.0, uTime * 0.0035, uTime * 0.0022));
    n = n * n * (3.0 - 2.0 * n);  // more contrast between puffs and gaps
    // Anvil region is stratiform: damp the noise so it spreads smooth and solid.
    float hh = clamp((p.y - CLOUD_BASE) / 8.0, 0.0, 1.0);
    n = mix(n, 0.78, 0.62 * smoothstep(0.62, 0.95, hh));
    // Helical striations around the rotating updraft barrel: the stacked-plate
    // banding of the mesocyclone, slowly turning about the main tower's axis.
    vec4 mt = uTowers[0];
    float hb = (p.y - CLOUD_BASE) / max(mt.w - CLOUD_BASE, 0.001);
    if (hb > 0.03 && hb < 0.62) {
      vec2 rel = p.xz - mt.xy;
      float rr = length(rel) / max(mt.z, 0.001);
      if (rr < 1.5) {
        float band = sin(p.y * 4.5 + atan(rel.y, rel.x) * 1.5 + n * 2.0 - uTime * 0.05);
        float bm = smoothstep(0.03, 0.18, hb) * (1.0 - smoothstep(0.42, 0.62, hb))
                 * (1.0 - smoothstep(0.90, 1.50, rr));
        n += band * 0.07 * bm;
      }
    }
    float thr = 0.85 - 0.30 * uCoverage;
    d = clamp((max(s, 0.0) + wallM * 0.9 - thr * (1.0 - n)) * 2.6, 0.0, 1.0);
    if (detail && d > 0.0 && d < 0.9) {
      float e = fbm3(q * 4.1 + vec3(uTime * 0.01, 0.0, 0.0));
      d = clamp(d - (1.0 - e) * (1.0 - d) * 0.55 * (1.0 - wallM * 0.5), 0.0, 1.0);
    }
    d *= uDensityMul;
  }
  // Mid-level scattered cumulus between the viewer and the storm.
  if (uMidClouds > 0.001 && p.y > 1.1 && p.y < 2.5) {
    float zfade = 1.0 - smoothstep(-6.5, -4.0, p.z);  // keep them at a distance
    if (zfade > 0.01) {
      vec3 qm = p * 0.85 + uSeedOffset * 1.7;
      qm.x += uTime * 0.02 * uWindSpeed;
      float nm = fbm5(qm);
      float vprof = smoothstep(1.1, 1.45, p.y) * (1.0 - smoothstep(1.9, 2.5, p.y));
      float thr = 1.02 - uMidClouds * 0.38;
      d += clamp((nm - thr) * 3.0, 0.0, 1.0) * vprof * zfade * uDensityMul * 0.6;
    }
  }
  // Rain shaft / virga under the storm core: a ragged curtain of hanging
  // streamers, not a clean ellipse — low sun lights it up and a smooth
  // analytic edge reads as a floating pancake.
  if (p.y < CLOUD_BASE + 0.2 && uRain.w > 0.0) {
    float r = length(p.xz - uRain.xy) / uRain.z;
    if (r < 1.0) {
      float streak = vnoise(vec3(p.x * 1.8, p.y * 0.15 + uTime * 0.15, p.z * 1.8) + uSeedOffset);
      float brk = vnoise(vec3(p.x * 0.8, p.y * 0.25, p.z * 0.8) + uSeedOffset * 1.9);
      float edge = smoothstep(1.0, 0.45, r);
      float vfade = 1.0 - smoothstep(CLOUD_BASE - 0.65 + brk * 0.45, CLOUD_BASE + 0.2, p.y);
      d += edge * vfade * (0.35 + 0.65 * streak) * (0.30 + 0.70 * brk) * uRain.w * 0.10;
    }
  }
  return d;
}

float lightVisibility(vec3 p, vec3 ld, float step0, int steps) {
  float tau = 0.0, t = step0 * 0.5, st = step0;
  for (int i = 0; i < 8; i++) {
    if (i >= steps) break;
    tau += cloudDensity(p + ld * t, false) * st;
    t += st;
    st *= 1.5;
  }
  // Beer-Lambert with a multi-scatter floor so cores stay readable.
  return max(exp(-SIGMA * 0.35 * tau), 0.18 * exp(-SIGMA * 0.06 * tau));
}

float hg(float mu, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
}
float phaseFn(float mu) { return mix(hg(mu, -0.28), hg(mu, 0.58), 0.7); }

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec2 boxT(vec3 ro, vec3 rd, vec3 mn, vec3 mx) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (mn - ro) * inv, t1 = (mx - ro) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

float raySegDist(vec3 ro, vec3 rd, vec3 a, vec3 b, out float tRay) {
  vec3 v = b - a, w = ro - a;
  float B = dot(rd, v), C = dot(v, v), D = dot(rd, w), E = dot(v, w);
  float denom = C - B * B;
  float s = (abs(denom) > 1e-7) ? clamp((E - B * D) / denom, 0.0, 1.0) : 0.0;
  vec3 q = a + v * s;
  float t = max(dot(q - ro, rd), 0.0);
  tRay = t;
  return length(ro + rd * t - q);
}

vec3 skyColor(vec3 rd) {
  float h = clamp(rd.y, 0.0, 1.0);
  vec3 horizon = uAmbColor * 0.28 + uFlashAmb * 0.8;
  vec3 zenith  = uAmbColor * 0.06 + uFlashAmb * 0.4;
  vec3 col = mix(horizon, zenith, pow(h, 0.50));
  float sd = max(dot(rd, uSunDir), 0.0);
  col += uSunColor * (0.22 * pow(sd, 6.0) + 3.0 * pow(sd, 800.0));
  // Stars, visible only where the sky is dark and above the horizon.
  float lum = dot(col, vec3(0.3, 0.5, 0.2));
  float starVis = clamp(1.0 - lum * 9.0, 0.0, 1.0) * smoothstep(0.02, 0.18, rd.y);
  if (starVis > 0.01) {
    vec3 sp = rd * 350.0;
    float hcell = hash13(floor(sp));
    if (hcell > 0.9972) {
      vec3 f = fract(sp) - 0.5;
      float b = max(0.0, 1.0 - length(f) * 3.2);
      float tw = 0.7 + 0.3 * sin(uTime * 2.5 + hcell * 91.0);
      col += vec3(0.72, 0.78, 0.95) * b * b * 0.45 * tw * starVis;
    }
  }
  // High, streaky cirrus sheet drifting with the wind.
  if (uCirrus > 0.001 && rd.y > 0.015) {
    vec2 cp = rd.xz / rd.y * 7.0;
    vec3 qc = vec3(cp.x * 0.045, cp.y * 0.085, 2.3);
    qc.x += uTime * 0.004 * uWindSpeed;
    float n = fbm5(qc + uSeedOffset * 0.31);
    float thr = 1.05 - uCirrus * 0.7;
    float cov = smoothstep(thr, thr + 0.30, n) * uCirrus;
    float fade = smoothstep(0.015, 0.10, rd.y);
    float sd2 = max(dot(rd, uSunDir), 0.0);
    vec3 cirCol = uAmbColor * 0.5 + uSunColor * (0.06 + 0.45 * pow(sd2, 5.0)) + uFlashAmb * 0.7;
    col = mix(col, cirCol, cov * fade * 0.85);
  }
  // Low, dark background cloud bank around the horizon.
  if (uBgClouds > 0.001 && rd.y < 0.42) {
    float n = fbm5(vec3(rd.x * 4.0, rd.y * 9.0, rd.z * 4.0)
                 + uSeedOffset * 0.53 + vec3(uTime * 0.002 * uWindSpeed, 0.0, 0.0));
    float horiz = 1.0 - smoothstep(0.0, 0.38, max(rd.y, 0.0));
    float thr = 1.30 - uBgClouds * 0.90 - horiz * 0.35;
    float cov = smoothstep(thr, thr + 0.25, n);
    vec3 bankCol = uAmbColor * (0.10 + 0.20 * n) + uFlashAmb * 0.5;
    col = mix(col, bankCol, cov * (1.0 - smoothstep(0.08, 0.42, max(rd.y, 0.0))));
  }
  return col;
}

vec3 groundColor(vec3 pos, float t) {
  vec3 alb = vec3(0.040, 0.046, 0.038);
  alb *= 0.6 + 0.7 * vnoise(vec3(pos.x * 1.3, 0.0, pos.z * 1.3));
  vec3 col = alb * (uAmbColor * 0.5 + uSunColor * max(uSunDir.y, 0.0) * 0.4 + uFlashAmb * 2.0);
  for (int i = 0; i < 3; i++) {
    float I = uFlashPos[i].w;
    if (I > 0.002) {
      vec3 L = uFlashPos[i].xyz - pos;
      float d2 = dot(L, L);
      float ndl = max(L.y * inversesqrt(max(d2, 1e-6)), 0.0);
      col += alb * uFlashColor[i] * I * ndl * 4.0 / (1.0 + d2 * 0.4);
    }
  }
  vec3 horizon = uAmbColor * 0.28 + uFlashAmb * 0.8;
  return mix(col, horizon, 1.0 - exp(-t * 0.055));
}

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - uResolution) / uResolution.y;
  float cy = cos(uLook.x), sy = sin(uLook.x);
  float cp = cos(uLook.y), sp = sin(uLook.y);
  vec3 fwd = vec3(sy * cp, sp, -cy * cp);
  vec3 right = vec3(cy, 0.0, sy);
  vec3 upv = cross(right, fwd);
  vec3 ro = uCamPos;
  vec3 rd = normalize(fwd + right * (uv.x * uFovTan) + upv * (uv.y * uFovTan));

  float tGround = (rd.y < -0.0005) ? (-ro.y / rd.y) : 1e9;

  // Lightning bolt: analytic glow from distance between the view ray and each segment.
  float boltGlow = 0.0;
  float boltTNear = 1e9, boltDNear = 1e9;
  if (uBoltCount > 0) {
    for (int i = 0; i < 48; i++) {
      if (i >= uBoltCount) break;
      float tR;
      float ds = raySegDist(ro, rd, uBoltA[i], uBoltB[i], tR);
      if (tR < tGround + 0.05) {
        boltGlow += 0.005 / (0.000012 + ds * ds);
        if (ds < boltDNear) { boltDNear = ds; boltTNear = tR; }
      }
    }
    boltGlow *= uBoltIntensity;
  }

  vec3 bg = (tGround < 1e8) ? groundColor(ro + rd * tGround, tGround) : skyColor(rd);

  vec3 acc = vec3(0.0);
  float T = 1.0;
  float boltSnapT = -1.0;
  float wsum = 0.0, tsum = 0.0;

  vec2 tb = boxT(ro, rd, uBoundsMin, uBoundsMax);
  float t0 = max(tb.x, 0.0);
  float t1 = min(tb.y, tGround);
  if (t1 > t0) {
    float dt = (t1 - t0) / float(uSteps);
    float t = t0 + dt * hash12(gl_FragCoord.xy);
    float ph = phaseFn(dot(rd, uSunDir));
    for (int i = 0; i < 256; i++) {
      if (i >= uSteps || t > t1) break;
      vec3 pos = ro + rd * t;
      if (boltSnapT < 0.0 && t > boltTNear) boltSnapT = T;
      float den = cloudDensity(pos, uHighDetail == 1);
      if (den > 0.0005) {
        float ext = SIGMA * den;
        float Ts = exp(-ext * dt);
        float vis = lightVisibility(pos, uSunDir, 0.14, uLightSteps);
        // The rain core and wall cloud sit in the storm's own shadow — the
        // short light march can't see the cloud mass above, so darken there
        // (both direct sun and the sky ambient, which is mostly blocked too).
        float under = 0.0;
        if (pos.y < CLOUD_BASE + 0.25) {
          float r1 = length(pos.xz - uRain.xy) / (uRain.z * 1.6);
          float r2 = length(pos.xz - uWall.xy) / (uWall.z * 2.5);
          under = smoothstep(0.0, 0.4, clamp(1.0 - min(r1, r2), 0.0, 1.0));
          // Ramp in gradually below the base so the lowering shades smoothly
          // into the storm above instead of switching dark at a seam.
          under *= 1.0 - smoothstep(CLOUD_BASE - 0.30, CLOUD_BASE + 0.25, pos.y);
          vis *= mix(1.0, 0.12, under);
        }
        vec3 S = uSunColor * 4.0 * vis * (ph * 1.5 + 0.05);
        float hn = clamp((pos.y - CLOUD_BASE) / 9.0, 0.0, 1.0);
        S += uAmbColor * (0.3 + 0.7 * hn) * 0.9 * mix(1.0, 0.55, under) + uFlashAmb * 0.5;
        for (int j = 0; j < 3; j++) {
          float I = uFlashPos[j].w;
          if (I > 0.002) {
            vec3 Lv = uFlashPos[j].xyz - pos;
            float d2 = dot(Lv, Lv);
            float dist = max(sqrt(d2), 1e-4);
            vec3 ld = Lv / dist;
            float fv = exp(-SIGMA * 0.25 *
              (cloudDensity(pos + ld * 0.05, false) * 0.05 +
               cloudDensity(pos + ld * 0.15, false) * 0.12));
            S += uFlashColor[j] * I * fv / (0.4 + d2 * 3.5);
          }
        }
        S *= den * SIGMA * 0.92;
        acc += T * (S - S * Ts) / max(ext, 1e-5);
        float w = T * (1.0 - Ts);
        wsum += w; tsum += w * t;
        T *= Ts;
        if (T < 0.004) break;
      }
      t += dt;
    }
  }
  if (boltSnapT < 0.0) boltSnapT = T;

  // Aerial perspective: fade distant cloud detail toward the horizon haze.
  if (wsum > 0.0001) {
    float f = 1.0 - exp(-(tsum / wsum) * 0.035);
    vec3 haze = uAmbColor * 0.30 + uFlashAmb;
    acc = mix(acc, haze * (1.0 - T), f * 0.85);
  }

  vec3 col = acc + T * bg;

  if (uBoltCount > 0 && boltGlow > 0.0001) {
    vec3 bcol = mix(uBoltColor, vec3(1.0), clamp(boltGlow * 0.35, 0.0, 0.85));
    col += bcol * boltGlow * boltSnapT;
  }

  // Distant treeline silhouette on the horizon.
  if (rd.y < 0.02) {
    float ang = atan(rd.x, 0.0001 - rd.z);
    float th = 0.002 + 0.007 * pow(vnoise(vec3(ang * 21.0, 1.7, 3.1)), 2.0)
             + 0.0025 * vnoise(vec3(ang * 87.0, 7.3, 9.1));
    float m = 1.0 - smoothstep(th, th + 0.0015, rd.y);
    // The treeline is a ground-level illusion — fade it out once airborne.
    m *= clamp(1.0 - (uCamPos.y - 0.25) * 1.5, 0.0, 1.0);
    vec3 silo = vec3(0.004, 0.005, 0.006) + uFlashAmb * 0.05;
    col = mix(col, silo, m);
  }

  col = aces(col * uExposure);
  col = pow(col, vec3(1.0 / 2.2));
  col += (hash12(gl_FragCoord.yx * 1.37) - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
}
`;
