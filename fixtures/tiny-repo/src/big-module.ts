export interface Point {
  x: number;
  y: number;
}

export function distance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function midpoint(a: Point, b: Point): Point {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

export function translate(point: Point, dx: number, dy: number): Point {
  return {
    x: point.x + dx,
    y: point.y + dy,
  };
}

export class Rectangle {
  constructor(
    public topLeft: Point,
    public width: number,
    public height: number,
  ) {}

  get area(): number {
    return this.width * this.height;
  }

  get bottomRight(): Point {
    return translate(this.topLeft, this.width, this.height);
  }

  contains(point: Point): boolean {
    const br = this.bottomRight;
    return (
      point.x >= this.topLeft.x &&
      point.x <= br.x &&
      point.y >= this.topLeft.y &&
      point.y <= br.y
    );
  }
}

export function boundingBox(points: Point[]): Rectangle {
  if (points.length === 0) {
    throw new Error('Cannot compute a bounding box of zero points');
  }

  let minX = points[0]!.x;
  let minY = points[0]!.y;
  let maxX = points[0]!.x;
  let maxY = points[0]!.y;

  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  return new Rectangle({ x: minX, y: minY }, maxX - minX, maxY - minY);
}

export function centroid(points: Point[]): Point {
  if (points.length === 0) {
    throw new Error('Cannot compute a centroid of zero points');
  }

  let sumX = 0;
  let sumY = 0;
  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
  }

  return {
    x: sumX / points.length,
    y: sumY / points.length,
  };
}

export function sortByDistanceFrom(origin: Point, points: Point[]): Point[] {
  return [...points].sort((a, b) => distance(origin, a) - distance(origin, b));
}

export function rotate90(point: Point, origin: Point): Point {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  return {
    x: origin.x - dy,
    y: origin.y + dx,
  };
}

export function reflectX(point: Point, axisY: number): Point {
  return {
    x: point.x,
    y: axisY - (point.y - axisY),
  };
}

export function reflectY(point: Point, axisX: number): Point {
  return {
    x: axisX - (point.x - axisX),
    y: point.y,
  };
}

export function scale(point: Point, origin: Point, factor: number): Point {
  return {
    x: origin.x + (point.x - origin.x) * factor,
    y: origin.y + (point.y - origin.y) * factor,
  };
}

export function polygonArea(points: Point[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i]!;
    const next = points[(i + 1) % points.length]!;
    total += current.x * next.y - next.x * current.y;
  }
  return Math.abs(total) / 2;
}
