// Vite's "?raw" import: the file's text as a string. Used to load the CSV bars of the golden cases.
declare module "*.csv?raw" {
  const text: string;
  export default text;
}
