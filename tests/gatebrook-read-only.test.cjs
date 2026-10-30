const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const root=path.resolve(__dirname,"..");
const read=p=>fs.readFileSync(path.join(root,p),"utf8");
const migration=read("supabase/migrations/202610300003_gatebrook_read_only_subscriptions.sql");
const access=read("supabase/functions/gatebrook-access/index.ts");
const dashboard=read("dashboard.html");
const settings=read("settings.html");
const billing=read("billing.html");
const intake=read("supabase/migrations/202610300002_gatebrook_request_subscription_enforcement.sql");

test("Read entitlement requires existing Stripe subscription, not unfinished Checkout",()=>{
 assert.match(migration,/s\.stripe_subscription_id is not null/);
 assert.match(migration,/s\.status in \('trialing','active','past_due','unpaid','paused','canceled'\)/);
 assert.doesNotMatch(migration,/s\.status in \([^)]*'incomplete'/);
 assert.match(migration,/flowos_private\.gatebrook_business_has_access\(target_business_id\)/);
});
test("Read-only helper is never callable anonymously",()=>{
 assert.match(migration,/revoke all on function flowos_private\.gatebrook_business_can_view\(uuid\)\s+from PUBLIC, anon/);
 assert.match(migration,/grant execute on function flowos_private\.gatebrook_business_can_view\(uuid\)\s+to authenticated,service_role/);
});
test("Lead and business SELECT policies remain membership-scoped",()=>{
 for(const table of ["businesses","leads"]){
   const fragment=migration.slice(migration.indexOf('create policy "business users can read their business'+(table==="leads"?" leads":"")+'" on public.'+table));
   assert.match(fragment,/auth\.uid\(\)/);
   assert.match(fragment,/flowos_private\.gatebrook_business_can_view/);
 }
});
test("Read-only mode adds SELECT but never relaxes write policy conditions",()=>{
 for(const table of ["business_request_forms","lead_custom_answers"]){
   assert.match(migration,new RegExp("on public\\\\."+table+"\\\\s+for select to authenticated"));
 }
 assert.doesNotMatch(migration,/for (?:insert|update|delete|all) to authenticated/i);
 assert.match(intake,/if not flowos_private\.gatebrook_business_has_access\(p_business_id\)/);
});
test("Previously stored lead answers, review queue, settings and services can be read",()=>{
 const names=["lead_custom_answers_owner_read","gatebrook_business_owner_review_read",
   "authenticated can read public or own profiles","authenticated can read public or own services",
   "gatebrook_read_only_request_form"];
 for(const name of names)assert.ok(migration.includes(name),"Missing "+name);
});
test("Access API grants view without granting editing and only for Stripe-linked historical subscribers",()=>{
 assert.match(access,/stripe_subscription_id/);
 assert.match(access,/const readOnly=!allowed&&!!sub\?\.stripe_subscription_id/);
 assert.match(access,/read_only:readOnly/);
 assert.match(access,/business_id:readOnly\?membership\.business_id:null/);
 assert.match(access,/next:readOnly\?"dashboard\.html"/);
 assert.match(access,/const allowed=!!sub&&\["active","trialing"\]\.includes\(sub\.status\)&&periodValid/);
});
test("Dashboard displays a clear banner and a billing management link",()=>{
 assert.match(dashboard,/id="readOnlyNotice"/);
 assert.match(dashboard,/Read-only workspace/);
 assert.match(dashboard,/href="billing\.html">Manage subscription/);
 assert.match(dashboard,/if \(!access\?\.allowed && !access\?\.read_only\)/);
});
test("Dashboard renders saved lead amounts as text, removing edit controls",()=>{
 assert.match(dashboard,/if \(currentReadOnly\) \{/);
 assert.match(dashboard,/aria-label="Saved lead values"/);
 assert.match(dashboard,/card\.querySelector\("\.actions"\)\?\.remove\(\)/);
 assert.match(dashboard,/if \(!currentReadOnly\) card\.appendChild\(actions\)/);
 assert.match(dashboard,/if \(currentReadOnly\) return;/);
});
test("Dashboard refresh rechecks billing state for expiry and reactivation",()=>{
 assert.match(dashboard,/currentReadOnly=access\.read_only===true&&!access\.allowed/);
 assert.match(dashboard,/functions\.invoke\("gatebrook-access",\{method:"GET"\}\)/);
 assert.match(dashboard,/readOnlyNotice"\)\.classList\.toggle\("hidden",!currentReadOnly\)/);
});
test("Settings are view-only when expired, including the form builder",()=>{
 assert.match(settings,/isReadOnly=access\.read_only===true && !access\.allowed/);
 assert.match(settings,/role=isReadOnly\?"viewer":membership\.role/);
 assert.match(settings,/\.querySelectorAll\("input,textarea,button"\).*disabled = true/);
 assert.match(settings,/GatebrookRequestBuilder\.init\(\{ supabaseClient, businessId, role \}\)/);
 assert.match(settings,/readOnlySettingsNotice/);
});
test("Billing page routes expired subscribers to their existing dashboard",()=>{
 assert.match(billing,/if\(data\?\.read_only\)/);
 assert.match(billing,/workspace is in read-only mode/);
 assert.match(billing,/\$\("dashboard"\)\.hidden=false/);
 assert.match(billing,/\$\("manage"\)\.hidden=false/);
});
test("Updated pages' inline scripts parse successfully",()=>{
 for(const [name,source] of [["dashboard",dashboard],["settings",settings],["billing",billing]]){
   const scripts=[...source.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)]
      .map(x=>x[1]).filter(x=>x.trim());
   assert.ok(scripts.length,name+" missing script");
   for(const script of scripts)assert.doesNotThrow(()=>new vm.Script(script),name+" JS syntax");
 }
});
