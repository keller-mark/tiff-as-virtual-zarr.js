// Reference: https://github.com/hms-dbmi/vizarr/blob/218bed91ef9b570cf913070a0f54f7fac0a70053/src/types.ts
/*
MIT License

Copyright (c) 2020 Trevor Manz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
declare namespace Ome {
  type Version = "0.1";

  interface Channel {
    active: boolean;
    coefficient: number;
    color: string;
    family: string;
    inverted: boolean;
    label?: string;
    window: {
      end: number;
      max?: number;
      min?: number;
      start: number;
    };
  }

  interface Omero {
    id: number;
    name?: string;
    version: Version;
    channels: Channel[];
    rdefs: {
      defaultT?: number;
      defaultZ?: number;
      model: "color" | "greyscale";
    };
  }

  interface Axis {
    name: string;
    type?: string;
  }

  type CoordinateTransformation =
    | {
        type: "scale";
        scale: Array<number>;
      }
    | {
        type: "translation";
        translation: Array<number>;
      };

  interface Dataset {
    path: string;
    coordinateTransformations?: Array<CoordinateTransformation>;
  }

  interface Multiscale {
    datasets: Array<Dataset>;
    version?: string;
    axes?: string[] | Axis[];
  }

  interface Bioformats2rawlayout {
    "bioformats2raw.layout": 3;
  }

  interface Acquisition {
    id: number;
    name?: string;
    maximumfieldcount?: number;
    description?: string;
    starttime?: number;
    /**
     * @deprecated
     */
    path?: string;
  }

  interface Plate {
    acquisitions?: Acquisition[];
    columns: { name: string }[];
    field_count: 4;
    name: string;
    rows: { name: string }[];
    version: Version;
    wells: { path: string }[];
  }

  interface Well {
    images: { path: string; acquisition?: number }[];
    version: Version;
  }

  interface ImageLabel {
    version: Version;
    colors?: Array<{
      "label-value": number;
      rgba: [r: number, g: number, b: number, a: number];
    }>;
    properties?: Array<{
      "label-value": number;
      "omero:roiId": number;
      "omero:shapeId": number;
    }>;
    /** Location of source image */
    source: {
      image: string;
    };
  }

  type Attrs =
    | { multiscales: Multiscale[] }
    | { omero: Omero; multiscales: Multiscale[] }
    | { plate: Plate }
    | { well: Well }
    | { "image-label": ImageLabel; multiscales: Multiscale[] };
}

export type { Ome };