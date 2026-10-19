(function () {
  "use strict";

  const templates = {
    general: { label: "General service business", fields: [] },
    cleaning: { label: "Cleaning company", fields: [
      { id: "property_type", label: "What type of property needs cleaning?", type: "select", required: true, options: ["House", "Apartment", "Office", "Move-in / move-out", "Other"] },
      { id: "cleaning_frequency", label: "How often do you need cleaning?", type: "select", required: false, options: ["One-time", "Weekly", "Biweekly", "Monthly", "Not sure"] }
    ] },
    plumbing: { label: "Plumbing company", fields: [
      { id: "plumbing_issue", label: "What plumbing issue do you need help with?", type: "select", required: true, options: ["Leak", "Clog", "Water heater", "Fixture installation", "Inspection", "Other"] },
      { id: "urgency", label: "How urgent is the issue?", type: "select", required: true, options: ["Emergency", "As soon as possible", "Within a week", "Planning ahead"] }
    ] },
    auto_detailing: { label: "Auto detailing", fields: [
      { id: "vehicle_details", label: "Vehicle year, make, and model", type: "text", required: true, placeholder: "2022 Toyota Camry" },
      { id: "detailing_package", label: "Which service are you interested in?", type: "select", required: true, options: ["Interior", "Exterior", "Full detail", "Paint correction", "Ceramic coating", "Not sure"] }
    ] },
    landscaping: { label: "Landscaping company", fields: [
      { id: "project_type", label: "What kind of landscaping do you need?", type: "select", required: true, options: ["Lawn care", "Cleanup", "Design / installation", "Hardscaping", "Snow / seasonal service", "Other"] },
      { id: "property_size", label: "Approximate property size or area", type: "text", required: false, placeholder: "Small yard, 1 acre, front garden..." }
    ] },
    photography: { label: "Photography", fields: [
      { id: "session_type", label: "What type of session do you need?", type: "select", required: true, options: ["Portrait", "Family", "Wedding", "Event", "Commercial", "Other"] },
      { id: "event_date", label: "Event or preferred session date", type: "date", required: false }
    ] }
  };

  const supportedTypes = ["text", "textarea", "select", "radio", "checkbox", "date", "number"];
  const root = document.getElementById("requestBuilder");
  if (!root) return;

  const $ = id => root.querySelector("#" + id);
  let client = null, businessId = null, role = null;
  let fields = [];
  let isLoading = false;
  let isDirty = false;

  function escapeText(s) { return String(s ?? ""); }
  function slugify(s) {
    const id = String(s || "question").toLowerCase().normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
    return id || "question";
  }
  function uniqueId(label) {
    const base = slugify(label);
    let id = base, n = 2;
    while (fields.some(f => f.id === id)) id = base.slice(0, 27) + "_" + n++;
    return id;
  }
  function cloneFields(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(f => f && typeof f === "object" && supportedTypes.includes(f.type))
      .slice(0, 20).map((f, i) => ({
        id: /^[a-z][a-z0-9_]{0,39}$/.test(f.id || "") ? f.id : "question_" + (i + 1),
        label: String(f.label || "Question").slice(0, 80),
        type: f.type,
        required: f.required === true,
        placeholder: String(f.placeholder || "").slice(0, 120),
        options: Array.isArray(f.options) ? f.options.map(x => String(x).slice(0, 80)).filter(Boolean).slice(0, 20) : []
      }));
  }
  function fieldOptions(type) { return ["select", "radio", "checkbox"].includes(type); }

  function setDirty() { isDirty = true; $("builderFeedback").textContent = "Unsaved changes"; $("builderFeedback").className = "feedback"; }
  function readBase() {
    return {
      template_key: $("formTemplate").value,
      page_title: $("formPageTitle").value.trim(),
      page_description: String(root.dataset.businessTagline || "").trim(),
      submit_label: $("formSubmitLabel").value.trim(),
      fields: fields.map(f => ({
        id: f.id, label: f.label.trim(), type: f.type, required: !!f.required,
        placeholder: (f.placeholder || "").trim(),
        ...(fieldOptions(f.type) ? { options: (f.options || []).map(v => v.trim()).filter(Boolean) } : {})
      }))
    };
  }
  function renderFieldEditor() {
    const host = $("customFieldList");
    host.replaceChildren();
    $("fieldCount").textContent = fields.length + " / 20 questions";
    if (!fields.length) {
      const empty = document.createElement("p");
      empty.className = "feedback";
      empty.textContent = "This template has no extra questions yet. Add your first question below.";
      host.appendChild(empty);
      return;
    }
    fields.forEach((field, index) => {
      const card = document.createElement("div");
      card.className = "gb-custom-field-row";
      const top = document.createElement("div"); top.className = "gb-custom-field-top";
      const number = document.createElement("strong"); number.textContent = "Question " + (index + 1);
      const actions = document.createElement("div"); actions.className = "gb-field-actions";
      for (const [label, delta, remove] of [["↑", -1, false], ["↓", 1, false], ["Remove", 0, true]]) {
        const button = document.createElement("button"); button.type = "button"; button.className = "btn"; button.textContent = label;
        button.disabled = role !== "owner" || (!remove && index + delta < 0) || (!remove && index + delta >= fields.length);
        button.addEventListener("click", () => {
          if (remove) fields.splice(index, 1);
          else { const swap = index + delta; [fields[index], fields[swap]] = [fields[swap], fields[index]]; }
          setDirty(); renderFieldEditor(); renderPreview();
        });
        actions.appendChild(button);
      }
      top.append(number, actions);
      const grid = document.createElement("div"); grid.className = "gb-field-editor-grid";
      const labelWrap = document.createElement("div");
      const label = document.createElement("label"); label.textContent = "Question label";
      const input = document.createElement("input"); input.maxLength = 80; input.value = field.label; input.required = true;
      input.addEventListener("input", () => { field.label = input.value; setDirty(); renderPreview(); });
      labelWrap.append(label, input);

      const typeWrap = document.createElement("div");
      const typeLabel = document.createElement("label"); typeLabel.textContent = "Answer type";
      const type = document.createElement("select");
      for (const t of supportedTypes) {
        const op = document.createElement("option"); op.value = t; op.textContent = ({text:"Short text",textarea:"Long text",select:"Dropdown",radio:"Single choice",checkbox:"Multiple choice",date:"Date",number:"Number"})[t]; type.appendChild(op);
      }
      type.value = field.type;
      type.addEventListener("change", () => { field.type = type.value; if (fieldOptions(field.type) && !field.options.length) field.options = ["Option 1", "Option 2"]; setDirty(); renderFieldEditor(); renderPreview(); });
      typeWrap.append(typeLabel, type);
      grid.append(labelWrap, typeWrap);

      const extra = document.createElement("div"); extra.className = "gb-field-extra";
      const placeholderWrap = document.createElement("div");
      const placeholderLabel = document.createElement("label"); placeholderLabel.textContent = "Placeholder (optional)";
      const placeholder = document.createElement("input"); placeholder.maxLength = 120; placeholder.value = field.placeholder || ""; placeholder.placeholder = "Help the customer answer";
      placeholder.addEventListener("input", () => { field.placeholder = placeholder.value; setDirty(); renderPreview(); });
      placeholderWrap.append(placeholderLabel, placeholder); extra.appendChild(placeholderWrap);
      if (fieldOptions(field.type)) {
        const optionsWrap = document.createElement("div");
        const optionsLabel = document.createElement("label"); optionsLabel.textContent = "Choices (separate with commas)";
        const options = document.createElement("input"); options.maxLength = 800; options.value = (field.options || []).join(", "); options.placeholder = "Option 1, Option 2";
        options.addEventListener("input", () => { field.options = options.value.split(",").map(v => v.trim()).filter(Boolean).slice(0, 20); setDirty(); renderPreview(); });
        optionsWrap.append(optionsLabel, options); extra.appendChild(optionsWrap);
      }
      grid.appendChild(extra);

      const requiredLabel = document.createElement("label"); requiredLabel.className = "gb-required-toggle";
      const required = document.createElement("input"); required.type = "checkbox"; required.checked = field.required; required.disabled = role !== "owner";
      required.addEventListener("change", () => { field.required = required.checked; setDirty(); renderPreview(); });
      requiredLabel.append(required, document.createTextNode(" Require an answer"));
      card.append(top, grid, requiredLabel);
      host.appendChild(card);
    });
  }

  function renderPreview() {
    const preview = $("requestPreview");
    preview.replaceChildren();
    preview.classList.add("gb-request-page");
    const base = readBase();

    // Mirror request.html's real customer-facing hierarchy and shared CSS classes.
    const wrap = document.createElement("div");
    wrap.className = "wrap";
    const powered = document.createElement("div");
    powered.className = "flowos";
    powered.innerHTML = '<span class="gb-mark" aria-hidden="true"><svg class="gb-brand-glyph" viewBox="0 0 179 143" xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true"><path class="gb-logo-frame" d="M1 0H178V77L161 64V17H19V124H90V142H1Z"/><path class="gb-logo-b" fill-rule="evenodd" d="M103 62H134L178 95V142H102Z M121 80L131 81L157 101L156 125L120 124Z"/><path class="gb-logo-g" d="M32 32V110L90 111V62H72L71 94L50 93V50L89 49L90 33Z"/><path class="gb-logo-cap" d="M103 32V49H126L129 52L147 51L146 32Z"/></svg></span><span class="gb-powered-label"><span>Powered by</span><strong>GATEBROOK</strong></span>';

    const logoUrl = root.dataset.businessLogo || "";
    if (logoUrl) {
      const logo = document.createElement("img");
      logo.className = "business-logo";
      logo.alt = "";
      logo.src = logoUrl;
      logo.style.display = "block";
      wrap.appendChild(powered);
      wrap.appendChild(logo);
    } else {
      wrap.appendChild(powered);
    }

    const business = document.createElement("h1");
    business.textContent = root.dataset.businessName || "Your business";
    const title = document.createElement("h2");
    title.className = "request-page-title";
    title.textContent = base.page_title || "Request a Service";
    const desc = document.createElement("div");
    desc.className = "tagline";
    desc.textContent = base.page_description || "Tell us what you need and we will follow up.";
    wrap.append(business, title, desc);
    const metaValues = [
      ["Phone", root.dataset.businessPhone || ""],
      ["Email", root.dataset.businessEmail || ""],
      ["Website", root.dataset.businessWebsite || ""]
    ].filter(([, value]) => value);
    if (metaValues.length) {
      const meta = document.createElement("div");
      meta.className = "business-meta";
      metaValues.forEach(([label, value], index) => {
        if (index) meta.appendChild(document.createTextNode(" · "));
        const item = document.createElement("span");
        item.textContent = label + ": " + value;
        meta.appendChild(item);
      });
      wrap.appendChild(meta);
    }

    const availableServices = (() => { try { return JSON.parse(root.dataset.services || "[]"); } catch (_) { return []; } })();
    const card = document.createElement("div");
    card.className = "card";
    const form = document.createElement("form");
    form.addEventListener("submit", event => event.preventDefault());
    const formGrid = document.createElement("div");
    formGrid.className = "grid";
    form.appendChild(formGrid);

    const addPreview = (label, type, required, placeholder, options, full = false) => {
      const group = document.createElement("div");
      if (full) group.className = "full";
      const lab = document.createElement("label");
      lab.textContent = label + (required ? " *" : "");
      const control = document.createElement(type === "textarea" ? "textarea" : (type === "select" ? "select" : "input"));
      if (type !== "textarea" && type !== "select") {
        control.type = ["number","date","email","tel"].includes(type) ? type : "text";
      }
      control.disabled = true;
      control.placeholder = placeholder || "";
      if (type === "select") {
        const op = document.createElement("option");
        op.textContent = "Choose a service";
        op.value = "";
        control.appendChild(op);
        (options || []).forEach(value => {
          const o = document.createElement("option");
          o.textContent = value;
          o.value = value;
          control.appendChild(o);
        });
      }
      group.append(lab, control);
      formGrid.appendChild(group);
    };

    [
      ["Name", "text", true, "John Smith", false],
      ["Phone", "tel", false, "7635551234", false],
      ["Email", "email", false, "john@example.com", false],
      ["Service", "select", true, "", false],
      ["Preferred Date", "date", false, "", false],
      ["Service Address / Location", "text", false, "Address or service location", false],
      ["Tell us what you need", "textarea", false, "Describe the job, problem, project, or anything the business should know.", true]
    ].forEach(([label,type,required,placeholder,full]) => addPreview(
      label,type,required,placeholder,type === "select" ? availableServices : [],full
    ));

    base.fields.forEach(field => {
      if (field.type === "radio" || field.type === "checkbox") {
        const group = document.createElement("div");
        group.className = "full custom-question";
        const label = document.createElement("label");
        label.textContent = field.label + (field.required ? " *" : "");
        group.appendChild(label);
        const choices = document.createElement("div");
        choices.className = "custom-choice-list";
        (field.options || []).forEach(value => {
          const optionLabel = document.createElement("label");
          optionLabel.className = "custom-choice";
          const input = document.createElement("input");
          input.type = field.type;
          input.disabled = true;
          input.style.width = "auto";
          optionLabel.append(input, document.createTextNode(value));
          choices.appendChild(optionLabel);
        });
        group.appendChild(choices);
        formGrid.appendChild(group);
      } else {
        addPreview(field.label,field.type,field.required,field.placeholder,field.options,field.type === "textarea");
      }
    });

    const button = document.createElement("button");
    button.id = "submitButton";
    button.type = "submit";
    button.textContent = base.submit_label || "Submit Request";
    button.disabled = true;
    form.appendChild(button);
    const security = document.createElement("div");
    security.className = "full security-area";
    const securityNote = document.createElement("div");
    securityNote.className = "security-note";
    securityNote.textContent = "Protected against automated spam.";
    security.appendChild(securityNote);
    form.appendChild(security);
    card.appendChild(form);

    const contactItems = [
      ["Phone", root.dataset.businessPhone || ""],
      ["Email", root.dataset.businessEmail || ""],
      ["Website", root.dataset.businessWebsite || ""]
    ].filter(([, value]) => value);
    if (contactItems.length) {
      const contact = document.createElement("details");
      contact.className = "gb-contact-disclosure";
      const summary = document.createElement("summary");
      summary.className = "gb-contact-trigger";
      summary.textContent = "Contact business";
      contact.appendChild(summary);
      const panel = document.createElement("div");
      panel.className = "gb-contact-panel";
      const caption = document.createElement("p");
      caption.className = "gb-contact-caption";
      caption.textContent = "Other ways to reach this business";
      panel.appendChild(caption);
      contactItems.forEach(([label, value]) => {
        const line = document.createElement("div");
        line.className = "gb-contact-value";
        line.textContent = label + ": " + value;
        panel.appendChild(line);
      });
      contact.appendChild(panel);
      card.appendChild(contact);
    }
    wrap.appendChild(card);
    preview.appendChild(wrap);
  }

  function renderTemplateDescription() {
    const tpl = templates[$("formTemplate").value] || templates.general;
    $("templateDescription").textContent = tpl.label + " starter questions can be edited, removed, reordered, or expanded.";
  }

  async function init(options) {
    client = options.supabaseClient; businessId = options.businessId; role = options.role;
    if (!client || !businessId) return;
    const canEdit = role === "owner";
    root.querySelectorAll("input,textarea,select,button").forEach(el => { if (el.id !== "formTemplate" || canEdit) el.disabled = !canEdit; });
    try {
      const { data, error } = await client.from("business_request_forms")
        .select("business_id,template_key,page_title,page_description,submit_label,fields")
        .eq("business_id", businessId).maybeSingle();
      if (error) throw error;
      if (data) {
        $("formTemplate").value = templates[data.template_key] ? data.template_key : "general";
        $("formPageTitle").value = data.page_title || "Request a Service";
        $("formSubmitLabel").value = data.submit_label || "Submit Request";
        fields = cloneFields(data.fields);
      } else {
        const industry = (root.dataset.industryHint || "").toLowerCase();
        const defaultKey = industry.includes("clean") ? "cleaning" : industry.includes("plumb") ? "plumbing" : industry.includes("detail") ? "auto_detailing" : industry.includes("landscap") ? "landscaping" : industry.includes("photo") ? "photography" : "general";
        $("formTemplate").value = defaultKey;
        $("formPageTitle").value = "Request a Service";
        $("formSubmitLabel").value = "Submit Request";
        fields = cloneFields(templates[defaultKey].fields);
      }
      if (!canEdit) root.querySelectorAll("input,textarea,select,button").forEach(el => el.disabled = true);
      root.querySelectorAll("[data-builder-input]").forEach(el => el.addEventListener("input", () => { if (role === "owner") { setDirty(); renderPreview(); } }));
      const taglineInput = document.getElementById("tagline");
      if (taglineInput) taglineInput.addEventListener("input", () => { root.dataset.businessTagline = taglineInput.value; renderPreview(); });
      $("formTemplate").addEventListener("change", () => {
        if (role !== "owner") return;
        const key = $("formTemplate").value;
        fields = cloneFields(templates[key]?.fields || []);
        renderTemplateDescription(); renderFieldEditor(); renderPreview(); setDirty();
      });
      $("addCustomField").addEventListener("click", () => {
        if (role !== "owner" || fields.length >= 20) return;
        fields.push({ id: uniqueId("question_" + (fields.length + 1)), label: "New question", type: "text", required: false, placeholder: "", options: [] });
        renderFieldEditor(); renderPreview(); setDirty();
      });
      $("saveRequestForm").addEventListener("click", save);
      renderTemplateDescription(); renderFieldEditor(); renderPreview();
      $("builderFeedback").textContent = canEdit ? "Changes are saved when you click Save request page." : "View-only access.";
    } catch (error) {
      $("builderFeedback").textContent = "Unable to load request page settings: " + (error.message || "Please refresh.");
      $("builderFeedback").className = "feedback error";
    }
  }

  async function save() {
    if (role !== "owner" || isLoading) return;
    const saveButton = $("saveRequestForm");
    const base = readBase();
    const seen = new Set();
    try {
      if (!base.page_title || base.page_title.length > 120) throw new Error("Add a page title up to 120 characters.");
      if (base.page_description.length > 500) throw new Error("Keep the description under 500 characters.");
      if (!base.submit_label || base.submit_label.length > 40) throw new Error("Add a submit label up to 40 characters.");
      if (base.fields.length > 20) throw new Error("Use no more than 20 custom questions.");
      for (const f of base.fields) {
        if (!f.label || f.label.length > 80) throw new Error("Each question needs a label under 80 characters.");
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(f.id) || seen.has(f.id)) throw new Error("Question IDs must be unique.");
        seen.add(f.id);
        if (fieldOptions(f.type) && (!f.options?.length || f.options.length > 20 || f.options.some(v => v.length > 80))) throw new Error("Choice fields need 1–20 choices, each under 80 characters.");
        if (f.placeholder.length > 120) throw new Error("Placeholders must be under 120 characters.");
      }
      isLoading = true; saveButton.disabled = true; saveButton.textContent = "Saving…";
      const { error } = await client.from("business_request_forms").upsert({
        business_id: businessId, ...base, updated_at: new Date().toISOString()
      }, { onConflict: "business_id" });
      if (error) throw error;
      isDirty = false;
      $("builderFeedback").textContent = "Request page saved. Your existing request link is unchanged.";
      $("builderFeedback").className = "feedback ok";
    } catch (error) {
      $("builderFeedback").textContent = error.message || "Unable to save request page.";
      $("builderFeedback").className = "feedback error";
    } finally {
      isLoading = false; saveButton.disabled = role !== "owner"; saveButton.textContent = "Save request page";
    }
  }

  window.GatebrookRequestBuilder = { init, refreshPreview: renderPreview };
})();