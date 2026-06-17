// Must load before PDF.js so `new Path2D()` picks up bbox tracking for bracket detection.
function newBBox() {
  return {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
}

function includeInto(bbox, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return;
  }
  if (x < bbox.minX) bbox.minX = x;
  if (y < bbox.minY) bbox.minY = y;
  if (x > bbox.maxX) bbox.maxX = x;
  if (y > bbox.maxY) bbox.maxY = y;
}

export function installTrackedPath2D() {
  const Native = globalThis.Path2D;
  if (!Native || Native.__tracked) {
    return;
  }

  class TrackedPath2D extends Native {
    constructor(arg) {
      super(arg);
      this.__bbox = newBBox();
      if (arg && typeof arg === "object" && arg.__bbox) {
        const b = arg.__bbox;
        includeInto(this.__bbox, b.minX, b.minY);
        includeInto(this.__bbox, b.maxX, b.maxY);
      }
    }

    moveTo(x, y) {
      includeInto(this.__bbox, x, y);
      return super.moveTo(x, y);
    }
    lineTo(x, y) {
      includeInto(this.__bbox, x, y);
      return super.lineTo(x, y);
    }
    rect(x, y, w, h) {
      includeInto(this.__bbox, x, y);
      includeInto(this.__bbox, x + w, y + h);
      return super.rect(x, y, w, h);
    }
    roundRect(x, y, w, h, r) {
      includeInto(this.__bbox, x, y);
      includeInto(this.__bbox, x + w, y + h);
      return super.roundRect(x, y, w, h, r);
    }
    bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) {
      includeInto(this.__bbox, cp1x, cp1y);
      includeInto(this.__bbox, cp2x, cp2y);
      includeInto(this.__bbox, x, y);
      return super.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
    }
    quadraticCurveTo(cpx, cpy, x, y) {
      includeInto(this.__bbox, cpx, cpy);
      includeInto(this.__bbox, x, y);
      return super.quadraticCurveTo(cpx, cpy, x, y);
    }
    arc(x, y, r, ...rest) {
      includeInto(this.__bbox, x - r, y - r);
      includeInto(this.__bbox, x + r, y + r);
      return super.arc(x, y, r, ...rest);
    }
    arcTo(x1, y1, x2, y2, r) {
      includeInto(this.__bbox, x1, y1);
      includeInto(this.__bbox, x2, y2);
      return super.arcTo(x1, y1, x2, y2, r);
    }
    ellipse(x, y, rx, ry, ...rest) {
      includeInto(this.__bbox, x - rx, y - ry);
      includeInto(this.__bbox, x + rx, y + ry);
      return super.ellipse(x, y, rx, ry, ...rest);
    }
    addPath(path, transform) {
      if (path && path.__bbox && Number.isFinite(path.__bbox.minX)) {
        const b = path.__bbox;
        const corners = [
          [b.minX, b.minY],
          [b.maxX, b.minY],
          [b.minX, b.maxY],
          [b.maxX, b.maxY],
        ];
        for (const [px, py] of corners) {
          if (transform) {
            includeInto(
              this.__bbox,
              transform.a * px + transform.c * py + transform.e,
              transform.b * px + transform.d * py + transform.f,
            );
          } else {
            includeInto(this.__bbox, px, py);
          }
        }
      }
      return super.addPath(path, transform);
    }
  }

  TrackedPath2D.__tracked = true;
  globalThis.Path2D = TrackedPath2D;
}

installTrackedPath2D();
