// Reference: https://github.com/vitessce/vitessce/blob/03a0bc90b3f3a9b3e1296ec566e66e7193ca88c0/packages/utils/image-utils/src/ome-tiff-types.ts

export type DimensionOrder = 'XYZCT'
  | 'XYZTC'
  | 'XYCTZ'
  | 'XYCZT'
  | 'XYTCZ'
  | 'XYTZC';

export type PixelType =
  | 'int8'
  | 'int16'
  | 'int32'
  | 'uint8'
  | 'uint16'
  | 'uint32'
  | 'float'
  | 'bit'
  | 'double'
  | 'complex'
  | 'double-complex';

export type UnitsLength =
  | 'Ym'
  | 'Zm'
  | 'Em'
  | 'Pm'
  | 'Tm'
  | 'Gm'
  | 'Mm'
  | 'km'
  | 'hm'
  | 'dam'
  | 'm'
  | 'dm'
  | 'cm'
  | 'mm'
  | 'µm'
  | 'nm'
  | 'pm'
  | 'fm'
  | 'am'
  | 'zm'
  | 'ym'
  | 'Å'
  | 'thou'
  | 'li'
  | 'in'
  | 'ft'
  | 'yd'
  | 'mi'
  | 'ua'
  | 'ly'
  | 'pc'
  | 'pt'
  | 'pixel'
  | 'reference frame';

export type Instrument = {
  Objective: {
    ID: string;
    Model: string;
    NominalMagnification: unknown;
  };
};

export type Channel = {
  ID: string;
  SamplesPerPixel: number;
  Name?: string;
  Color?: number[]; // [R, G, B, A]
};

export type Pixels = {
  Channels: Channel[];
  TiffData: {
    IFD: string;
    PlaneCount: number;
  };
  PhysicalSizeX: number;
  PhysicalSizeXUnit: UnitsLength;
  PhysicalSizeY: number;
  PhysicalSizeYUnit: UnitsLength;
  PhysicalSizeZ: number;
  PhysicalSizeZUnit: UnitsLength;
  SizeT: number;
  SizeC: number;
  SizeZ: number;
  SizeY: number;
  SizeX: number;
  SignificantBits: number;
  BigEndian: boolean;
  Interleaved: boolean;
  ID: string;
  DimensionOrder: DimensionOrder;
  Type: PixelType;
}

export type Image = {
  ID: string;
  Name: string;
  AquisitionDate?: string;
  Description?: string;
  Pixels: Pixels;
  InstrumentRef: { ID: string };
  ObjectiveSettings: { ID: string };
}

export type OME = {
  Instrument: Instrument;
  Image: Image | Image[];
}