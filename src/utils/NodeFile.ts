//@raa polyfill fix for nodejs implementation of File
export class NodeFile implements File {
  name: string;
  lastModified: number;
  size: number;
  type: string;
  webkitRelativePath: string;
  private buffer: Buffer;

  constructor(buffer: Buffer, filename: string, options: { type?: string } = {}) {
    this.buffer = buffer;
    this.name = filename;
    this.lastModified = Date.now();
    this.size = buffer.length;
    this.type = options.type || 'application/octet-stream';
    this.webkitRelativePath = '';
  }

  bytes(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(this.buffer));
  }

  slice(start?: number, end?: number, contentType?: string): Blob {
    const slicedBuffer = this.buffer.slice(start, end);
    return new NodeFile(slicedBuffer, this.name, { type: contentType });
  }

  stream(): ReadableStream {
    return new ReadableStream({
      start: (controller) => {
        controller.enqueue(this.buffer);
        controller.close();
      }
    });
  }

  text(): Promise<string> {
    return Promise.resolve(this.buffer.toString('utf-8'));
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(this.buffer.buffer);
  }

  async *[Symbol.asyncIterator]() {
    yield this.buffer;
  }

  get [Symbol.toStringTag](): string {
    return 'File';
  }
}