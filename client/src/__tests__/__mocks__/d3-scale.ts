export function scaleTime() {
  let domain: [Date, Date] = [new Date(0), new Date(0)];
  let range: [number, number] = [0, 1];
  const scale: any = (x: Date) => {
    const [d0, d1] = domain;
    const t = (x.getTime() - d0.getTime()) / (d1.getTime() - d0.getTime());
    return range[0] + t * (range[1] - range[0]);
  };
  scale.domain = (d?: [Date, Date]) => { if (d) { domain = d; return scale; } return domain; };
  scale.range = (r?: [number, number]) => { if (r) { range = r; return scale; } return range; };
  return scale;
}
