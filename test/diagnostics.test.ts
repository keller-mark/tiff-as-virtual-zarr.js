import { describe, it, expect } from 'vitest';
import { fromFile, GeoTIFFImage } from 'geotiff';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';


const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'fixtures');

describe('TIFF fixture diagnostics', () => {
  it('9836842 v0_3 - basic structure and sub-IFDs', async () => {
    const tiff = await fromFile(join(FIXTURES, '9836842.v0_3.ome.tif')) as any;
    const count = await tiff.getImageCount();
    console.log('Image count:', count);
    console.log('tiff.littleEndian:', tiff.littleEndian, 'bigTiff:', tiff.bigTiff);

    const img0 = await tiff.getImage(0) as any;
    const fd0 = img0.fileDirectory;
    console.log('fd0 keys:', JSON.stringify(Object.keys(fd0)));
    console.log('Compression:', fd0.Compression);
    console.log('BitsPerSample:', Array.from(fd0.BitsPerSample || []));
    console.log('SampleFormat:', fd0.SampleFormat ? Array.from(fd0.SampleFormat) : undefined);
    console.log('ImageDescription[:500]:', fd0.ImageDescription?.slice(0, 500));
    console.log('SubIFDs:', fd0.SubIFDs ? Array.from(fd0.SubIFDs) : null);
    console.log('TileWidth:', fd0.TileWidth, 'TileLength:', fd0.TileLength);
    console.log('ImageWidth:', fd0.ImageWidth, 'ImageLength:', fd0.ImageLength);
    console.log('img0.source keys:', JSON.stringify(Object.keys(img0.source || {})));

    // Try parseFileDirectoryAt for sub-IFD
    const subIFDs = fd0.SubIFDs;
    if (subIFDs && subIFDs.length > 0) {
      const subIfdOffset = Number(subIFDs[0]);
      console.log('Sub-IFD[0] byte offset:', subIfdOffset);
      const subIfdResult = await tiff.parseFileDirectoryAt(subIfdOffset);
      console.log('parseFileDirectoryAt result keys:', JSON.stringify(Object.keys(subIfdResult)));
      console.log('subIfd.fileDirectory keys:', JSON.stringify(Object.keys(subIfdResult.fileDirectory)));
      const sfd = subIfdResult.fileDirectory;
      console.log('sub-IFD ImageWidth:', sfd.ImageWidth, 'ImageLength:', sfd.ImageLength);
      console.log('sub-IFD TileWidth:', sfd.TileWidth, 'TileLength:', sfd.TileLength);
      // Create GeoTIFFImage from sub-IFD
      const subImg = new GeoTIFFImage(
        subIfdResult.fileDirectory,
        subIfdResult.geoKeyDirectory,
        img0.dataView,
        tiff.littleEndian,
        false,
        tiff.source
      );
      console.log('subImg.getWidth():', subImg.getWidth(), 'getHeight():', subImg.getHeight());
    }

    // Test raw tile fetch via source
    const tileOffsets = fd0.TileOffsets;
    const tileByteCounts = fd0.TileByteCounts;
    if (tileOffsets && tileByteCounts) {
      const result = await img0.source.fetch([{
        offset: Number(tileOffsets[0]),
        length: Number(tileByteCounts[0]),
      }]);
      console.log('raw tile[0] bytes length:', result[0]?.byteLength);
    }

    expect(count).toBeGreaterThan(0);
  });

  it('10501752 v0_4 - 50 channel CYX image', async () => {
    const tiff = await fromFile(join(FIXTURES, '10501752.v0_4.ome.tif')) as any;
    const count = await tiff.getImageCount();
    console.log('Image count:', count);
    const img0 = await tiff.getImage(0) as any;
    const fd0 = img0.fileDirectory;
    console.log('Compression:', fd0.Compression, 'Width:', fd0.ImageWidth, 'Height:', fd0.ImageLength);
    console.log('BitsPerSample:', Array.from(fd0.BitsPerSample || []));
    console.log('SampleFormat:', fd0.SampleFormat ? Array.from(fd0.SampleFormat) : undefined);
    console.log('SubIFDs:', fd0.SubIFDs ? Array.from(fd0.SubIFDs).slice(0, 4) : null, '...(len:', fd0.SubIFDs?.length, ')');
    console.log('ImageDescription[:800]:', fd0.ImageDescription?.slice(0, 800));
    expect(count).toBeGreaterThan(0);
  });

  it('v0_5 - YX image', async () => {
    const tiff = await fromFile(join(FIXTURES, 'ExpD_chicken_embryo_MIP.v0_5.ome.tif')) as any;
    const count = await tiff.getImageCount();
    console.log('Image count:', count);
    const img0 = await tiff.getImage(0) as any;
    const fd0 = img0.fileDirectory;
    console.log('Compression:', fd0.Compression, 'Width:', fd0.ImageWidth, 'Height:', fd0.ImageLength);
    console.log('BitsPerSample:', Array.from(fd0.BitsPerSample || []));
    console.log('SampleFormat:', fd0.SampleFormat ? Array.from(fd0.SampleFormat) : undefined);
    console.log('SubIFDs:', fd0.SubIFDs ? Array.from(fd0.SubIFDs).slice(0, 5) : null);
    console.log('ImageDescription[:1200]:', fd0.ImageDescription?.slice(0, 1200));
    expect(count).toBeGreaterThan(0);
  });
});
