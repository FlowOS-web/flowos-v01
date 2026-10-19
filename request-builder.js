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
  function renderQuestionSummary() {
    const host = $("questionReviewList");
    if (!host) return;
    host.replaceChildren();
    if (!fields.length) {
      const empty = document.createElement("p");
      empty.className = "gb-field-help";
      empty.textContent = "No extra questions for this starter. That’s fine — the standard contact and service fields are already included.";
      host.appendChild(empty);
      return;
    }
    fields.forEach(field => {
      const item = document.createElement("div");
      item.className = "gb-question-review-item";
      const check = document.createElement("span");
      check.className = "gb-question-review-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = "✓";
      const copy = document.createElement("div");
      copy.className = "gb-question-review-copy";
      const label = document.createElement("strong");
      label.textContent = field.label || "Untitled question";
      const meta = document.createElement("span");
      const typeLabels = {text:"Short answer",textarea:"Long answer",select:"Choose one",radio:"Choose one",checkbox:"Choose any",date:"Date",number:"Number"};
      meta.textContent = (typeLabels[field.type] || "Answer") + (field.required ? " · Required" : " · Optional");
      copy.append(label, meta);
      item.append(check, copy);
      host.appendChild(item);
    });
  }

  function renderFieldEditor() {
    const host = $("customFieldList");
    host.replaceChildren();
    $("fieldCount").textContent = fields.length + " suggested";
    renderQuestionSummary();
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

  let previewFrame = null;
  let previewFrameReady = false;
  let previewFrameHeight = 760;

  window.addEventListener("message", event => {
    if (!previewFrame || event.source !== previewFrame.contentWindow || event.origin !== window.location.origin) return;
    if (event.data?.type === "gatebrook-preview-ready") {
      previewFrameReady = true;
      sendPreviewData();
    } else if (event.data?.type === "gatebrook-preview-height" && Number.isFinite(event.data.height)) {
      previewFrameHeight = Math.max(520, Math.min(2400, event.data.height));
      previewFrame.style.height = previewFrameHeight + "px";
    }
  });

  function sendPreviewData() {
    if (!previewFrame?.contentWindow || !previewFrameReady) return;
    const base = readBase();
    let services = [];
    try { services = JSON.parse(root.dataset.services || "[]"); } catch (_) {}
    previewFrame.contentWindow.postMessage({
      type: "gatebrook-preview-data",
      payload: {
        businessName: root.dataset.businessName || "Your business",
        logoUrl: root.dataset.businessLogo || "",
        tagline: base.page_description,
        phone: root.dataset.businessPhone || "",
        email: root.dataset.businessEmail || "",
        website: root.dataset.businessWebsite || "",
        pageTitle: base.page_title,
        submitLabel: base.submit_label,
        services,
        fields: base.fields
      }
    }, window.location.origin);
  }

  function renderPreview() {
    const preview = $("requestPreview");
    if (!previewFrame) {
      preview.replaceChildren();
      previewFrame = document.createElement("iframe");
      previewFrame.title = "Live customer request page preview";
      previewFrame.setAttribute("loading", "eager");
      previewFrame.setAttribute("referrerpolicy", "same-origin");
      previewFrame.style.cssText = "display:block;width:100%;height:" + previewFrameHeight + "px;border:0;border-radius:12px;background:#0d0f13;overflow:hidden;";
      previewFrame.addEventListener("load", () => {
        previewFrameReady = true;
        sendPreviewData();
      });
      const isV1Preview = window.location.pathname.includes("/v1-preview/");
      previewFrame.src = new URL((isV1Preview ? "../" : "") + "request.html?preview=1", window.location.href).href;
      preview.appendChild(previewFrame);
    }
    sendPreviewData();
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