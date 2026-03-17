import { type Pixels, type Channel, type DimensionOrder } from './ome-tiff-types.js';

// ── OME-XML parser ────────────────────────────────────────────────────────────
export async function parseOmeXml(xml: string): Promise<{ pixels: Pixels; channels: Channel[] }> {
  let parser: DOMParser;
  if (typeof DOMParser !== 'undefined') {
    parser = new DOMParser();
  } else {
    // Node.js / test environment — xmldom must be installed as a dep
    // @ts-expect-error – xmldom ships no type declarations; only used as a Node.js fallback
    const { DOMParser: NodeDOMParser } = await import(/* @vite-ignore */ 'xmldom');
    parser = new NodeDOMParser() as unknown as DOMParser;
  }

  const doc = parser.parseFromString(xml, 'text/xml');
  const pixelsEl = doc.getElementsByTagName('Pixels')[0];
  if (!pixelsEl) throw new Error('No Pixels element in OME-XML');

  const ga = (name: string): string | null => pixelsEl.getAttribute(name);

  const pixels: Pixels = {
    ID: ga('ID') ?? '',
    DimensionOrder: (ga('DimensionOrder') ?? 'XYCZT') as DimensionOrder,
    Type: (ga('Type') ?? 'uint8') as Pixels['Type'],
    SizeX: parseInt(ga('SizeX') ?? '0'),
    SizeY: parseInt(ga('SizeY') ?? '0'),
    SizeZ: parseInt(ga('SizeZ') ?? '1'),
    SizeT: parseInt(ga('SizeT') ?? '1'),
    SizeC: parseInt(ga('SizeC') ?? '1'),
    PhysicalSizeX: toFloat(ga('PhysicalSizeX')),
    PhysicalSizeXUnit: ga('PhysicalSizeXUnit') as Pixels['PhysicalSizeXUnit'],
    PhysicalSizeY: toFloat(ga('PhysicalSizeY')),
    PhysicalSizeYUnit: ga('PhysicalSizeYUnit') as Pixels['PhysicalSizeYUnit'],
    PhysicalSizeZ: toFloat(ga('PhysicalSizeZ')),
    PhysicalSizeZUnit: ga('PhysicalSizeZUnit') as Pixels['PhysicalSizeZUnit'],
    SignificantBits: parseInt(ga('SignificantBits') ?? '0'),
    BigEndian: ga('BigEndian') === 'true',
    Interleaved: ga('Interleaved') === 'true',
    TiffData: { IFD: '', PlaneCount: 0 },
    Channels: [],
  };

  const channelEls = doc.getElementsByTagName('Channel');
  const channels: Channel[] = [];
  for (let i = 0; i < channelEls.length; i++) {
    const el = channelEls[i];
    const colorStr = el.getAttribute('Color');
    let color: number[] | undefined;
    if (colorStr != null) {
      // OME Color is a packed signed 32-bit RGBA integer
      const u = parseInt(colorStr) >>> 0;
      color = [(u >>> 24) & 0xff, (u >>> 16) & 0xff, (u >>> 8) & 0xff, u & 0xff];
    }
    channels.push({
      ID: el.getAttribute('ID') ?? `Channel:0:${i}`,
      SamplesPerPixel: parseInt(el.getAttribute('SamplesPerPixel') ?? '1'),
      ...(el.getAttribute('Name') != null ? { Name: el.getAttribute('Name')! } : {}),
      ...(color ? { Color: color } : {}),
    });
  }
  pixels.Channels = channels;

  return { pixels, channels };
}

function toFloat(s: string | null): number {
  return s != null ? parseFloat(s) : 0;
}

// ── Unit conversion (OME-XML → UDUNITS-2 / OME-NGFF) ─────────────────────────
// OME-XML uses symbol shorthand (e.g. "µm"); OME-NGFF expects the UDUNITS-2
// full name (e.g. "micrometer").
const OME_UNIT_TO_NGFF: Record<string, string> = {
  Ym: 'yottameter', Zm: 'zettameter', Em: 'exameter', Pm: 'petameter',
  Tm: 'terameter', Gm: 'gigameter', Mm: 'megameter', km: 'kilometer',
  hm: 'hectometer', dam: 'decameter', m: 'meter', dm: 'decimeter',
  cm: 'centimeter', mm: 'millimeter', µm: 'micrometer', nm: 'nanometer',
  pm: 'picometer', fm: 'femtometer', am: 'attometer', zm: 'zeptometer',
  ym: 'yoctometer', Å: 'angstrom',
  thou: 'thou', li: 'link', in: 'inch', ft: 'foot', yd: 'yard',
  mi: 'mile', ua: 'astronomicalUnit', ly: 'lightYear', pc: 'parsec',
  pt: 'point', pixel: 'pixel', 'reference frame': 'referenceFrame',
};

export function omeUnitToNgff(unit: string | null | undefined): string | undefined {
  if (!unit) return undefined;
  return OME_UNIT_TO_NGFF[unit] ?? unit;
}

// ── Type conversion ───────────────────────────────────────────────────────────
export function omeTypeToZarr(omeType: string): string {
  const map: Record<string, string> = {
    uint8: 'uint8', uint16: 'uint16', uint32: 'uint32',
    int8: 'int8', int16: 'int16', int32: 'int32',
    float: 'float32', double: 'float64',
    bit: 'uint8',
  };
  return map[omeType] ?? 'uint8';
}

// ── IFD index calculation (ported from Viv's getRelativeOmeIfdIndex) ──────────
export function getRelativeIfdIndex(
  sel: { t: number; z: number; c: number },
  dimensionOrder: DimensionOrder,
  sizes: { t: number; z: number; c: number },
): number {
  const { t, z, c } = sel;
  switch (dimensionOrder) {
    case 'XYZCT': return z + sizes.z * c + sizes.z * sizes.c * t;
    case 'XYZTC': return z + sizes.z * t + sizes.z * sizes.t * c;
    case 'XYCTZ': return c + sizes.c * t + sizes.c * sizes.t * z;
    case 'XYCZT': return c + sizes.c * z + sizes.c * sizes.z * t;
    case 'XYTCZ': return t + sizes.t * c + sizes.t * sizes.c * z;
    case 'XYTZC': return t + sizes.t * z + sizes.t * sizes.z * c;
    default: throw new Error(`Invalid DimensionOrder: ${dimensionOrder}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
export function encodeJson(obj: object): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}
