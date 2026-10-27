declare module "pdfjs-dist/legacy/build/pdf.min.mjs" {
  const pdfjs: any;
  export default pdfjs;
  export const GlobalWorkerOptions: any;
  export function getDocument(src: any): any;
  export const PDFDataRangeTransport: any;
}
declare module "pdfjs-dist/legacy/build/pdf.worker.min.mjs" {
  const worker: string;
  export default worker;
}
