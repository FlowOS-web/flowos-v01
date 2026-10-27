/* Gatebrook's searchable service-industry picker. No external dependencies. */
(() => {
  "use strict";

  // Keep these as friendly, service-oriented names. The checkout API accepts
  // any non-empty industry label up to 120 characters.
  const CATEGORIES = [
    {
      name: "Home & property",
      items: [
        ["House cleaning", "home maid residential cleaning"],
        ["Deep cleaning", "move out move in cleaning"],
        ["Commercial cleaning", "office janitorial cleaning"],
        ["Carpet & upholstery cleaning", "rug furniture steam cleaning"],
        ["Window cleaning", "glass cleaning"],
        ["Pressure washing", "power washing exterior"],
        ["Gutter cleaning", "gutters"],
        ["Air duct cleaning", "ductwork ventilation"],
        ["HVAC services", "heating cooling air conditioning AC furnace"],
        ["Plumbing", "plumber pipes drains water heater"],
        ["Electrical services", "electrician wiring electrical"],
        ["Handyman services", "odd jobs home repairs"],
        ["Roofing", "roof repair replacement roofer"],
        ["Siding installation & repair", "vinyl siding"],
        ["Interior & exterior painting", "house painter"],
        ["Drywall installation & repair", "plaster sheetrock"],
        ["Flooring installation", "hardwood vinyl laminate floors"],
        ["Tile installation", "backsplash tile setter"],
        ["Carpentry", "woodworking trim"],
        ["General contracting", "contractor construction"],
        ["Home remodeling", "home renovation"],
        ["Kitchen & bathroom remodeling", "bath renovation"],
        ["Landscaping", "landscape design gardening"],
        ["Lawn care", "mowing yard maintenance"],
        ["Tree services", "tree trimming arborist removal"],
        ["Snow removal", "plowing snow clearing"],
        ["Pest control", "exterminator insects rodents"],
        ["Pool & spa maintenance", "pool cleaning hot tub"],
        ["Junk removal", "hauling trash disposal"],
        ["Moving services", "movers relocation"],
        ["Home inspections", "home inspector"],
        ["Property management", "rental property"],
        ["Fence installation & repair", "fencing"],
        ["Deck & patio services", "decking"],
        ["Garage door services", "overhead doors"],
        ["Locksmith services", "locks keys"],
        ["Appliance repair", "refrigerator washer dryer"],
        ["Home organizing", "decluttering organizer"],
        ["Insulation installation", "attic insulation"],
        ["Mold remediation", "mold cleanup"],
        ["Water damage restoration", "flood restoration"],
        ["Fire damage restoration", "smoke restoration"],
        ["Septic services", "septic tanks"],
        ["Irrigation & sprinkler services", "sprinklers"],
        ["Solar installation", "solar panels"],
        ["Security system installation", "alarms cameras"],
        ["Window & glass repair", "glazier glass"],
        ["Holiday lighting", "christmas lights"],
        ["Chimney cleaning & repair", "chimney sweep"]
      ]
    },
    {
      name: "Automotive & transportation",
      items: [
        ["Auto detailing", "car detailer vehicle cleaning"],
        ["Mobile auto detailing", "mobile car detailer"],
        ["Car wash", "vehicle washing"],
        ["Auto repair", "mechanic car service"],
        ["Mobile mechanic", "on-site auto repair"],
        ["Oil change services", "oil lubrication"],
        ["Tire sales & services", "wheel tires rotation"],
        ["Auto glass repair", "windshield chips"],
        ["Windshield replacement", "windshield glass"],
        ["Paint correction & ceramic coating", "auto polishing ceramic"],
        ["Auto body repair", "collision body shop"],
        ["Vehicle wrapping", "car wrap decals"],
        ["Towing & roadside assistance", "tow truck emergency roadside"],
        ["Car audio installation", "stereo automotive"],
        ["Motorcycle repair", "motorbike"],
        ["RV repair", "recreational vehicle camper"],
        ["Boat detailing", "marine detailing"],
        ["Boat repair", "marine mechanics"],
        ["Fleet maintenance", "commercial vehicles"],
        ["Transportation & shuttle services", "driver airport shuttle"]
      ]
    },
    {
      name: "Beauty & personal care",
      items: [
        ["Hair salon", "hairdresser hairstylist haircuts"],
        ["Barbershop", "barber men's haircuts"],
        ["Nail salon", "manicure pedicure nail technician"],
        ["Makeup artistry", "makeup artist bridal"],
        ["Lash & brow services", "eyelashes eyebrows extensions"],
        ["Skincare & facials", "esthetician skin treatments"],
        ["Massage therapy", "massage therapist"],
        ["Spa services", "day spa wellness"],
        ["Personal styling", "wardrobe stylist"],
        ["Tailoring & alterations", "sewing dress alterations"],
        ["Laundry & dry cleaning", "clothing wash"],
        ["Personal chef services", "private chef meal prep"]
      ]
    },
    {
      name: "Pets & animal care",
      items: [
        ["Pet grooming", "dog cat groomer"],
        ["Mobile pet grooming", "on-site groomer"],
        ["Dog walking", "pet walker"],
        ["Pet sitting", "pet sitter"],
        ["Dog training", "obedience puppy training"],
        ["Pet boarding & daycare", "kennel dog daycare"],
        ["Aquarium maintenance", "fish tanks"],
        ["Horse care & boarding", "equine horse stable"]
      ]
    },
    {
      name: "Events & creative services",
      items: [
        ["Photography", "photographer portraits"],
        ["Real estate photography", "property listing photos"],
        ["Videography", "video production"],
        ["Wedding planning", "wedding coordinator"],
        ["Event planning", "events party coordination"],
        ["Catering", "food service events"],
        ["Custom cakes & baking", "bakery cakes"],
        ["Floral design", "florist flowers"],
        ["DJ services", "disc jockey music"],
        ["Live entertainment", "performers bands"],
        ["Party rentals", "bounce house party equipment"],
        ["Event furniture & equipment rentals", "chairs tents tables"],
        ["Photo booth rental", "photobooth"],
        ["Event decorations", "balloons decor"],
        ["Event venue services", "venue coordinator"],
        ["Graphic design", "designer logos branding"],
        ["Web design", "website designer"],
        ["Printing & signage", "print shop banners"],
        ["Social media management", "social marketing content"],
        ["Content creation", "content marketing video posts"]
      ]
    },
    {
      name: "Business & professional services",
      items: [
        ["Accounting & bookkeeping", "accountant bookkeeper"],
        ["Tax preparation", "tax filing"],
        ["Business consulting", "business consultant"],
        ["Virtual assistant", "remote admin assistant"],
        ["Administrative services", "office assistance"],
        ["Marketing agency", "marketing advertising"],
        ["SEO services", "search engine optimization"],
        ["IT support", "information technology computer support"],
        ["Managed IT services", "managed service provider msp"],
        ["Computer repair", "laptop desktop PC repair"],
        ["Phone & device repair", "smartphone mobile screen repair"],
        ["Business coaching", "business mentor"],
        ["Recruiting & staffing", "hiring employment"],
        ["Document preparation", "forms document services"],
        ["Translation & interpretation", "translator interpreter"],
        ["Notary services", "notary public"],
        ["Commercial property services", "building services"],
        ["Insurance agency", "insurance agent"],
        ["Travel planning", "travel agent itinerary"],
        ["Interior design", "interior decorator"],
        ["Real estate services", "realtor real estate agent"]
      ]
    },
    {
      name: "Education & coaching",
      items: [
        ["Tutoring", "academic tutor"],
        ["Test preparation", "exam preparation"],
        ["Language lessons", "language teaching"],
        ["Music lessons", "piano guitar singing"],
        ["Art lessons", "drawing painting classes"],
        ["Career coaching", "career adviser"],
        ["Personal training", "fitness trainer"],
        ["Yoga instruction", "yoga teacher"],
        ["Pilates instruction", "pilates classes"],
        ["Dance instruction", "dance lessons"],
        ["Sports coaching", "athletic training"],
        ["Golf instruction", "golf lessons"],
        ["Swimming lessons", "swim instructor"],
        ["Martial arts instruction", "karate judo classes"]
      ]
    },
    {
      name: "Other services",
      items: [
        ["Equipment repair", "tools machinery repair"],
        ["Equipment rental", "machinery rentals"],
        ["Furniture assembly", "furniture installer"],
        ["Furniture refinishing", "furniture restoration"],
        ["Delivery & courier services", "local delivery messenger"],
        ["Home staging", "real estate staging"],
        ["Mobile welding", "welder metalworking"],
        ["Other service business", "miscellaneous something else other"]
      ]
    }
  ];

  const entries = CATEGORIES.flatMap(group =>
    group.items.map(([label, keywords]) => ({
      label,
      category: group.name,
      matchText: normalize(label + " " + group.name + " " + keywords)
    }))
  );
  const popularNames = [
    "House cleaning", "HVAC services", "Plumbing", "Landscaping", "Lawn care",
    "Auto detailing", "Auto repair", "Photography", "Handyman services",
    "Commercial cleaning", "Pet grooming", "Other service business"
  ];
  const popular = popularNames.map(label => entries.find(item => item.label === label)).filter(Boolean);
  const popularSet = new Set(popularNames);

  function normalize(value) {
    return String(value || "").normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function rank(item, query) {
    const name = normalize(item.label);
    if (name === query) return 0;
    if (name.startsWith(query)) return 1;
    if (name.includes(query)) return 2;
    if (item.matchText.includes(query)) return 3;
    const words = query.split(" ").filter(Boolean);
    return words.every(word => item.matchText.includes(word)) ? 4 : Infinity;
  }

  function init() {
    const input = document.getElementById("industrySearch");
    const actual = document.getElementById("industry");
    const combo = document.getElementById("industryCombo");
    const toggle = document.getElementById("industryToggle");
    const menu = document.getElementById("industryDropdown");
    const list = document.getElementById("industryOptions");
    const feedback = document.getElementById("industryFeedback");
    const summary = document.getElementById("industryResultCount");
    if (!input || !actual || !combo || !toggle || !menu || !list || !feedback || !summary) {
      throw new Error("The industry selector is missing part of its markup.");
    }

    let visible = [];
    let activeIndex = -1;
    let browseAll = false;

    function isOpen() { return !menu.hidden; }
    function updateExpanded(open) {
      menu.hidden = !open;
      input.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-expanded", String(open));
      combo.classList.toggle("is-open", open);
      if (!open) input.removeAttribute("aria-activedescendant");
    }
    function close() {
      updateExpanded(false);
      activeIndex = -1;
    }
    function setActive(index) {
      if (!visible.length) return;
      activeIndex = (index + visible.length) % visible.length;
      const nodes = list.querySelectorAll('[role="option"]');
      nodes.forEach((node, i) => {
        const active = i === activeIndex;
        node.classList.toggle("is-active", active);
        node.setAttribute("aria-selected", String(active));
        if (active) {
          input.setAttribute("aria-activedescendant", node.id);
          node.scrollIntoView({ block: "nearest" });
        }
      });
    }
    function storeSelection(label) {
      const value = String(label || "").trim().replace(/\s+/g, " ").slice(0, 100);
      actual.value = value;
      input.value = value;
      input.setCustomValidity("");
      feedback.textContent = value ? "Selected: " + value : "";
      feedback.classList.toggle("is-selected", Boolean(value));
      close();
      // Persist immediately through the form's existing draft-saving handler.
      actual.dispatchEvent(new Event("input", { bubbles: true }));
    }
    function setValue(label) {
      storeSelection(label);
    }
    function appendHeader(label) {
      const heading = document.createElement("div");
      heading.className = "industry-group-title";
      heading.setAttribute("role", "presentation");
      heading.textContent = label;
      list.appendChild(heading);
    }
    function appendOption(option) {
      const index = visible.length;
      visible.push(option);
      const element = document.createElement("div");
      element.className = "industry-option" + (option.custom ? " is-custom" : "");
      element.id = "industry-option-" + index;
      element.setAttribute("role", "option");
      element.setAttribute("aria-selected", "false");
      const name = document.createElement("span");
      name.className = "industry-option-label";
      name.textContent = option.custom ? 'Use "' + option.label + '" as my industry' : option.label;
      const category = document.createElement("small");
      category.textContent = option.custom ? "Custom industry" : option.category;
      element.append(name, category);
      element.addEventListener("pointerdown", event => event.preventDefault());
      element.addEventListener("click", () => storeSelection(option.label));
      list.appendChild(element);
    }
    function render() {
      list.replaceChildren();
      visible = [];
      activeIndex = -1;
      input.removeAttribute("aria-activedescendant");
      const typed = input.value.trim();
      const query = browseAll || (actual.value && actual.value === input.value) ? "" : normalize(typed);
      if (!query) {
        appendHeader("Popular choices");
        popular.forEach(appendOption);
        for (const group of CATEGORIES) {
          const remaining = entries.filter(item =>
            item.category === group.name && !popularSet.has(item.label));
          if (!remaining.length) continue;
          appendHeader(group.name);
          remaining.forEach(appendOption);
        }
        summary.textContent = "Browse " + entries.length + " industries, or type to search";
        return;
      }
      const matches = entries.map(item => ({ item, score: rank(item, query) }))
        .filter(match => Number.isFinite(match.score))
        .sort((a, b) => a.score - b.score || a.item.label.localeCompare(b.item.label));
      if (matches.length) {
        appendHeader("Matching industries");
        matches.forEach(match => appendOption(match.item));
      }
      const isExistingName = entries.some(item => normalize(item.label) === query);
      if (!isExistingName && typed.length >= 2) {
        appendHeader("Can't find your industry?");
        appendOption({ label: typed.replace(/\s+/g, " ").slice(0, 100), category: "Custom industry", custom: true });
      }
      if (!visible.length) {
        const empty = document.createElement("div");
        empty.className = "industry-empty";
        empty.textContent = "Keep typing to search, or choose an existing industry.";
        list.appendChild(empty);
      }
      summary.textContent = matches.length + (matches.length === 1 ? " match" : " matches") +
        " · You can also enter your own";
    }
    function open() {
      render();
      updateExpanded(true);
    }
    input.addEventListener("focus", () => { browseAll = false; open(); });
    input.addEventListener("input", () => {
      browseAll = false;
      actual.value = "";
      feedback.textContent = "";
      feedback.classList.remove("is-selected");
      input.setCustomValidity(input.value.trim()
        ? "Choose an industry from the dropdown, or select the option to use your own."
        : "");
      open();
    });
    input.addEventListener("keydown", event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!isOpen()) open();
        setActive(activeIndex + (event.key === "ArrowDown" ? 1 : -1));
      } else if (event.key === "Enter" && isOpen()) {
        event.preventDefault();
        if (visible.length) storeSelection(visible[activeIndex >= 0 ? activeIndex : 0].label);
      } else if (event.key === "Escape" && isOpen()) {
        event.preventDefault();
        storeSelection(actual.value);
      } else if (event.key === "Tab") {
        close();
      }
    });
    input.addEventListener("invalid", () => {
      if (input.value.trim() && !actual.value) {
        input.setCustomValidity("Choose an industry from the dropdown, or select the option to use your own.");
      }
      browseAll = false;
      open();
    });
    toggle.addEventListener("click", () => {
      if (isOpen()) {
        close();
      } else {
        browseAll = true;
        open();
        input.focus();
        browseAll = true;
        render();
      }
    });
    document.addEventListener("pointerdown", event => {
      if (!combo.contains(event.target)) close();
    });

    return { setValue, getValue: () => actual.value, count: entries.length };
  }

  window.GatebrookIndustryPicker = { init };
})();