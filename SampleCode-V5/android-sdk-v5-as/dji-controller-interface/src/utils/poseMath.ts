export type EulerDegrees = {
  roll: number;
  pitch: number;
  yaw: number;
};

type Matrix3 = [number, number, number, number, number, number, number, number, number];

type Vector3 = {
  x: number;
  y: number;
  z: number;
};

function deg2rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function rotationMatrixFromEuler({ roll, pitch, yaw }: Partial<EulerDegrees>): Matrix3 {
  const r = deg2rad(roll ?? 0);
  const p = deg2rad(pitch ?? 0);
  const y = deg2rad(yaw ?? 0);

  const cr = Math.cos(r);
  const sr = Math.sin(r);
  const cp = Math.cos(p);
  const sp = Math.sin(p);
  const cy = Math.cos(y);
  const sy = Math.sin(y);

  return [
    cy * cp,
    cy * sp * sr - sy * cr,
    cy * sp * cr + sy * sr,
    sy * cp,
    sy * sp * sr + cy * cr,
    sy * sp * cr - cy * sr,
    -sp,
    cp * sr,
    cp * cr,
  ];
}

export function multiplyMatrixVector(m: Matrix3, v: Vector3): Vector3 {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}

export function multiplyMatrices(a: Matrix3, b: Matrix3): Matrix3 {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
    a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
    a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
    a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
    a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
    a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
    a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ];
}

export function vectorRotate(v: Vector3, ...matrices: Array<Matrix3>): Vector3 {
  return matrices.reduce<Vector3>((acc, m) => multiplyMatrixVector(m, acc), v);
}

export function normalizeVector(v: Vector3): Vector3 {
  const mag = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
  return { x: v.x / mag, y: v.y / mag, z: v.z / mag };
}

export function combineRotationMatrices(matrices: Matrix3[]): Matrix3 {
  return matrices.reduce<Matrix3>((acc, m) => multiplyMatrices(acc, m), [
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ]);
}
