export async function load(url, context, nextLoad) {
  const pathname = new URL(url).pathname;
  if (/\.(?:png|jpe?g|gif|svg|css|woff2?)$/i.test(pathname)) {
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(url)};`,
    };
  }
  return nextLoad(url, context);
}
