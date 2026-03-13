import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { getMagick } from './magick-wasm.js';

function inferFormat(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'JPEG';
  if (lower.endsWith('.png')) return 'PNG';
  if (lower.endsWith('.gif')) return 'GIF';
  if (lower.endsWith('.webp')) return 'WEBP';
  if (lower.endsWith('.bmp')) return 'BMP';
  if (lower.endsWith('.tiff') || lower.endsWith('.tif')) return 'TIFF';
  if (lower.endsWith('.avif')) return 'AVIF';
  return 'PNG'; // default
}

interface ParsedOperation {
  type: 'resize' | 'rotate' | 'crop' | 'quality';
  value: string;
}

function convertHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `usage: convert [input] [operations...] [output]

Operations:
  -resize WxH        resize to width x height
  -resize WxH!       resize to exact dimensions (ignore aspect ratio)
  -resize N%         resize by percentage
  -rotate degrees    rotate image by degrees
  -crop WxH+X+Y      crop to width x height at position X,Y
  -quality N         set output quality (0-100)

Examples:
  convert input.jpg -resize 800x600 output.png
  convert photo.png -resize 50% smaller.png
  convert image.jpg -rotate 90 -quality 85 rotated.jpg
  convert input.png -crop 100x100+50+50 cropped.png
`,
    stderr: '',
    exitCode: 0,
  };
}

export function createConvertCommand(name: string = 'convert'): Command {
  return defineCommand(name, async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return convertHelp();
    }

    // Parse arguments
    const positional: string[] = [];
    const operations: ParsedOperation[] = [];

    let i = 0;
    while (i < args.length) {
      const arg = args[i];

      if (arg === '-resize') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
          return {
            stdout: '',
            stderr: `${name}: missing argument for -resize\n`,
            exitCode: 1,
          };
        }
        operations.push({ type: 'resize', value: args[i + 1] });
        i += 2;
      } else if (arg === '-rotate') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
          return {
            stdout: '',
            stderr: `${name}: missing argument for -rotate\n`,
            exitCode: 1,
          };
        }
        operations.push({ type: 'rotate', value: args[i + 1] });
        i += 2;
      } else if (arg === '-crop') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
          return {
            stdout: '',
            stderr: `${name}: missing argument for -crop\n`,
            exitCode: 1,
          };
        }
        operations.push({ type: 'crop', value: args[i + 1] });
        i += 2;
      } else if (arg === '-quality') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
          return {
            stdout: '',
            stderr: `${name}: missing argument for -quality\n`,
            exitCode: 1,
          };
        }
        operations.push({ type: 'quality', value: args[i + 1] });
        i += 2;
      } else if (arg.startsWith('-')) {
        return {
          stdout: '',
          stderr: `${name}: unsupported option ${arg}\n`,
          exitCode: 1,
        };
      } else {
        positional.push(arg);
        i++;
      }
    }

    if (positional.length !== 2) {
      return {
        stdout: '',
        stderr: `${name}: expected exactly one input file and one output file\n`,
        exitCode: 1,
      };
    }

    const inputPath = positional[0];
    const outputPath = positional[1];

    try {
      // Read input file
      const resolvedInput = ctx.fs.resolvePath(ctx.cwd, inputPath);
      const inputData = await ctx.fs.readFileBuffer(resolvedInput);

      // Initialize ImageMagick
      const magick = await getMagick();

      // Process image
      let outputData: Uint8Array | null = null;

      await magick.ImageMagick.read(inputData, async (image) => {
        // Apply operations in order
        for (const op of operations) {
          switch (op.type) {
            case 'resize': {
              const resizeMatch = op.value.match(/^(\d+)%$/);
              if (resizeMatch) {
                // Percentage resize
                const percent = parseInt(resizeMatch[1], 10);
                const newWidth = Math.round(image.width * percent / 100);
                const newHeight = Math.round(image.height * percent / 100);
                image.resize(newWidth, newHeight);
              } else {
                // WxH or WxH! format
                const ignoreAspect = op.value.endsWith('!');
                const sizeStr = ignoreAspect ? op.value.slice(0, -1) : op.value;
                const parts = sizeStr.split('x');

                if (parts.length === 2) {
                  const width = parseInt(parts[0], 10);
                  const height = parseInt(parts[1], 10);

                  if (ignoreAspect) {
                    // Create geometry with ignoreAspectRatio flag
                    const geo = new magick.MagickGeometry(width, height);
                    geo.ignoreAspectRatio = true;
                    image.resize(geo);
                  } else {
                    image.resize(width, height);
                  }
                } else {
                  throw new Error(`Invalid resize format: ${op.value}`);
                }
              }
              break;
            }
            case 'rotate': {
              const degrees = parseFloat(op.value);
              if (isNaN(degrees)) {
                throw new Error(`Invalid rotation degrees: ${op.value}`);
              }
              image.rotate(degrees);
              break;
            }
            case 'crop': {
              // Parse WxH+X+Y format
              const cropMatch = op.value.match(/^(\d+)x(\d+)\+(\d+)\+(\d+)$/);
              if (!cropMatch) {
                throw new Error(`Invalid crop format: ${op.value} (expected WxH+X+Y)`);
              }

              // Use string constructor which accepts ImageMagick geometry format
              const geo = new magick.MagickGeometry(op.value);
              image.crop(geo);
              break;
            }
            case 'quality': {
              const quality = parseInt(op.value, 10);
              if (isNaN(quality) || quality < 0 || quality > 100) {
                throw new Error(`Invalid quality: ${op.value} (must be 0-100)`);
              }
              image.quality = quality;
              break;
            }
          }
        }

        // Write output
        const outputFormat = inferFormat(outputPath) as any; // MagickFormat type
        image.write(outputFormat, (data: Uint8Array) => {
          outputData = data;
        });
      });

      if (!outputData) {
        throw new Error('Failed to generate output image');
      }

      // Write output file
      const resolvedOutput = ctx.fs.resolvePath(ctx.cwd, outputPath);
      await ctx.fs.writeFile(resolvedOutput, outputData);

      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
      };
    } catch (err) {
      return {
        stdout: '',
        stderr: `${name}: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }
  });
}
