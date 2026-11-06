/** One completed build publication; the bundle is removed immediately afterwards. */
export const name = 'tps-client-rebuild-once';
export const inject = ['clientModules'];
export function apply(ctx) {
  const id = '@local/dsh-tps-metrics-fix';
  let published = false;
  const publish = () => {
    if (published || ctx.clientModules.clientPath(id) === undefined) return;
    published = true;
    const revision = ctx.clientModules.rebuilt(id);
    if (revision === undefined) throw new Error('TPS client artifact could not be published');
  };
  ctx.effect(() => ctx.clientModules.onGraphChanged(publish), 'tps-client-rebuild-once: graph readiness');
  publish();
}
