export let versionString = "0.5.0";

import { populateSolidTab, loginAndFetch, solidLogout } from "./solid.js";

let markers = [];
let loaded = new Set();
let alignmentGrids = {};
let scoreAlignment; // score tstamp to ref tstamp maps for onset and offset
let timemap = []; // verovio timemap
let ref;
export let currentAudioIx = "";
export let currentlyAnnotatedRegions = []; // alignment indexes of start and end for each active annotated region
export let maoSelections = [];
let referenceAudioIx;
let colorMap;
let timerFrom = 0;
let timerTo = 0;
let tk; // verovio toolkit
export let storage;
export let meiUri;
export let currentlyActiveMaoSelection = "";
export let wavesurfers = {};

try {
  storage = window.localStorage;
} catch (err) {
  console.warn("unable to access local storage: ", err);
}

function seekToLastMark() {
  if (markers.length) {
    const currentAlignmentIx = getClosestAlignmentIx();
    const prevMarkers = markers.filter((m) => m <= currentAlignmentIx);
    let lastMarker;
    if (prevMarkers.length) lastMarker = prevMarkers[prevMarkers.length - 1];
    else lastMarker = 0;
    wavesurfers[currentAudioIx].seekTo(
      getCorrespondingTime(currentAudioIx, lastMarker) /
        wavesurfers[currentAudioIx].getDuration()
    );
  }
}

function getClosestAlignmentIx(
  time = wavesurfers[currentAudioIx].getCurrentTime(),
  audioIx = currentAudioIx
) {
  console.log("Get closest alignment Ix: ", time, audioIx);
  // return alignment index closest to supplied time (default: current playback position)
  let currentGrid = alignmentGrids[audioIx];
  // find the nearest marker to current playback time
  const lower = currentGrid.filter((t) => t <= time);
  // ix for closest marker below current time
  let closestAlignmentIx = lower.length;
  // if next marker (closest above current time) is closer, switch to it
  if (
    closestAlignmentIx < currentGrid.length &&
    time - currentGrid[closestAlignmentIx] > currentGrid[closestAlignmentIx + 1]
  )
    closestAlignmentIx += 1;
  return closestAlignmentIx;
}

export function getCorrespondingTime(audioIx, alignmentIx) {
  // get time position corresponding to current position of current audio,
  // in the alternative audio with index audioIx
  let grid = alignmentGrids[audioIx];
  return grid[alignmentIx];
}

function onClickRenditionName(e) {
  // Catches clicks on checkboxes or labels
  // Used to load / switch to the respective rendition
  let checkbox;
  if (e.target.nodeName.toLowerCase() === "label") {
    // retrieve checkbox
    checkbox = document.getElementById(e.target.for);
  } else if (e.target.nodeName.toLowerCase === "li") {
    checkbox = e.target.querySelector("input");
  } else {
    checkbox = e.target;
  }
  console.log("CLick: ", e);
  console.log("Checkbox: ", checkbox);

  if (checkbox.value) {
    const status = document
      .getElementById(checkbox.value)
      .querySelector("label").classList;
    if (!status.contains("ready") && !status.contains("loading")) {
      status.add("loading");
    }
    prepareWaveform(checkbox.value);
    console.log("Clicked!", checkbox.value);
  }
}

function onClickRenditionCheckbox(e) {
  // n.b. separate handler to onClickRenditionName
  // used only to specifically show/hide renditions when
  // they have already loaded
  let checkbox = e.target;
  let checked = checkbox.checked;
  let label = checkbox.parentElement.querySelector("label");
  let waveform = document.getElementById("waveform-" + e.target.value + "-wav");
  let spectrogram = document.getElementById(
    "waveform-" + e.target.value + "-spec"
  );
  if (!checked) {
    e.stopPropagation(); // hide from other handler
    waveform.style.display = "none";
    spectrogram.style.display = "none";
    checkbox.checked = false;
    label.classList.remove("ready");
    label.classList.add("loading");
  } else if (label.classList.contains("loading")) {
    e.stopPropagation(); // hide from other handler
    waveform.style.display = "unset";
    if (document.getElementById("showSpectrograms").checked)
      spectrogram.style.display = "unset";
    checkbox.checked = true;
    label.classList.remove("loading");
    label.classList.add("ready");
  } else {
    // user clicked unloaded checkbox, so it is now checked
    // uncheck it again - it wil set itself after loading finished
    checkbox.checked = false;
  }
}

function swapCurrentAudio(newAudio) {
  if (currentAudioIx === newAudio) {
    // no need to swap
    return;
  }
  if (currentAudioIx) {
    console.log("Pausing current: ", currentAudioIx);
    console.log(
      "Current duration: ",
      wavesurfers[currentAudioIx].getDuration()
    );
    const wasPlaying = wavesurfers[currentAudioIx].isPlaying();
    wavesurfers[currentAudioIx].pause();
    let closestAlignmentIx = getClosestAlignmentIx();
    document
      .getElementById(`waveform-${currentAudioIx}` + "-wav")
      .classList.remove("active");
    // swap to new audio and alignment grid
    currentAudioIx = newAudio;
    console.log("new audio ix: ", currentAudioIx);
    let currentGrid = alignmentGrids[currentAudioIx];
    console.log("new audio grid: ", alignmentGrids[currentAudioIx]);
    console.log("new duration: ", wavesurfers[currentAudioIx].getDuration());
    let newWaveform = document.getElementById(
      `waveform-${currentAudioIx}` + "-wav"
    );
    // highlight as active
    newWaveform.classList.add("active");
    // scroll to position
    let bbox = newWaveform.getBoundingClientRect();
    let waveforms = document.getElementById("waveforms");
    waveforms.scrollTo({
      top: bbox.top + waveforms.scrollTop - 128,
      left: 0,
      behavior: "smooth",
    });
    // seek to new (corresponding) position
    let transitionToLastMark =
      document.getElementById(`transitionType`).checked;
    console.log("transitionToLastMark: ", transitionToLastMark);
    let correspondingPosition = currentGrid[closestAlignmentIx];
    let newPosition =
      correspondingPosition / wavesurfers[currentAudioIx].getDuration();
    wavesurfers[currentAudioIx].seekTo(newPosition);
    if (transitionToLastMark) {
      seekToLastMark();
    }
    if (wasPlaying) wavesurfers[currentAudioIx].play();
  } else {
    currentAudioIx = newAudio;
    const newActiveWaveform = document.getElementById(
      `waveform-${currentAudioIx}` + "-wav"
    );
    if (newActiveWaveform) {
      newActiveWaveform.classList.add("active");
    }
  }
}

function generateCheckboxList(list) {
  console.log("Generate checkbox list: ", list);
  // generate content for <ul>:
  // <li> containing a checkbox for each list member
  const ul = document.createElement("ul");
  list.forEach((n) => {
    const li = document.createElement("li");
    li.classList.add("renditionName");
    li.id = n;
    const checkboxSpan = document.createElement("span");
    const checkbox = document.createElement("input");
    checkbox.id = "checkbox-" + n;
    checkbox.name = "checkbox-" + n;
    checkbox.type = "checkbox";
    checkbox.classList.add("renditionCheckbox");
    checkbox.value = n;
    const label = document.createElement("label");
    label.for = "checkbox-" + n;
    label.innerText = n.substr(n.indexOf("/") + 1); // HACK, use semantic title
    checkboxSpan.appendChild(checkbox);
    checkboxSpan.appendChild(label);
    li.appendChild(checkboxSpan);
    ul.appendChild(li);
  });
  return ul;
}

function reloadWaveforms() {
  let playPosition = 0;
  let isPlaying = false;
  const prevLoaded = Object.keys(wavesurfers);
  if (currentAudioIx) {
    playPosition = wavesurfers[currentAudioIx].getCurrentTime();
    isPlaying = wavesurfers[currentAudioIx].isPlaying();
  }
  // get current play position of active wavesurfer
  // destroy current wavesurfers
  prevLoaded.forEach((ws) => wavesurfers[ws].destroy());
  wavesurfers = {};
  // forget waveform elements (and spectorgrams)
  document.getElementById("waveforms").replaceChildren();
  // re-create previously loaded waveforms
  prevLoaded.forEach((ws) => prepareWaveform(ws, playPosition, isPlaying));
}

function visualiseAlignments() {
  // go through all wavesurfers, throw out user-defined markers, and instead draw in alignment positions as markers
  Object.keys(wavesurfers).forEach((ws) => {
    wavesurfers[ws].clearMarkers();
    alignmentGrids[ws].forEach((t) => {
      wavesurfers[ws].addMarker({ time: t, color: "red" });
      wavesurfers[ws].on("hover", (e) => {
        console.log("HOVER: ", e);
      });
    });
  });
}

function prepareWaveform(filename, playPosition = 0, isPlaying = false) {
  console.log(
    "preparing waveform, currently annotated regions:",
    currentlyAnnotatedRegions
  );
  // if not yet created, do so:
  if (!(filename in wavesurfers)) {
    const waveform = document.createElement("div");
    waveform.id = "waveform-" + filename + "-wav";
    waveform.dataset.ix = filename;
    waveform.classList.add("waveform");
    const spectrogram = document.createElement("div");
    spectrogram.id = "waveform-" + filename + "-spec";
    spectrogram.dataset.ix = filename;
    spectrogram.classList.add("spectrogram");
    let waveforms = document.getElementById("waveforms");
    // add elements to waveforms
    waveforms.appendChild(spectrogram);
    waveforms.appendChild(waveform);
    // now resort waveforms to maintain order, prioritizing VPO
    let vpo = [...waveforms.children].filter((n) =>
      n.id.substr(n.id.lastIndexOf("/") + 1).startsWith("VPO-")
    );
    let other = [...waveforms.children].filter(
      (n) => !n.id.substr(n.id.lastIndexOf("/") + 1).startsWith("VPO-")
    );
    vpo
      .sort((a, b) => (a.id > b.id ? 1 : -1))
      .forEach((node) => waveforms.appendChild(node));
    other
      .sort((a, b) => (a.id > b.id ? 1 : -1))
      .forEach((node) => waveforms.appendChild(node));
    // create new wavesurfer instance in the new container
    /* HACK (DH 2023): eventually, show all annotated regions
     * For now, only allow one at a time
     */
    let regions = extractCurrentlyAnnotatedRegions(filename);
    let annoRegions = WaveSurfer.regions.create({ regions });
    //let annoRegions = [];
    /*
    let annoFrom = 0;
    let annoTo = 0;
    if (currentlyAnnotatedRegions.length) {
      annoFrom = currentlyAnnotatedRegions[0].from;
      annoTo = currentlyAnnotatedRegions[0].to;
    }
    annoRegions = WaveSurfer.regions.create({
      regions: [
        {
          id: "anno_region_0",
          start: getCorrespondingTime(filename, annoFrom),
          end: getCorrespondingTime(filename, annoTo),
          drag: false,
          color: "rgba(200, 130, 80, 0.3)",
        },
      ],
    });*/

    wavesurfers[filename] = WaveSurfer.create({
      container: `#${CSS.escape("waveform-" + filename) + "-wav"}`,
      waveColor: "violet",
      progressColor: "purple",
      normalize: document.getElementById("normalize").checked,
      plugins: [
        WaveSurfer.markers.create({}),
        WaveSurfer.spectrogram.create({
          wavesurfer: wavesurfers[filename],
          container: `#${CSS.escape("waveform-" + filename + "-spec")}`,
          labels: true,
          colorMap: colorMap,
          height: 128,
        }),
        WaveSurfer.cursor.create({
          showTime: true,
          opacity: 1,
          customShowTimeStyle: {
            "background-color": "#000",
            color: "#fff",
            padding: "2px",
            "font-size": "10px",
          },
        }),
        WaveSurfer.regions.create({
          regions: [
            {
              id: "timer",
              start: 0,
              end: 0,
              drag: false,
              resize: false,
              color: "rgba(255, 0, 100, 0.3)",
            },
          ],
        }),
        annoRegions,
      ],
    });
    // add filename label marker
    wavesurfers[filename].addMarker({
      time: 0,
      label: filename,
      color: "black",
      position: "top",
    });
    // add any user-generated markers
    markers.forEach((m) => {
      const t = getCorrespondingTime(filename, m);
      wavesurfers[filename].addMarker({ time: t, color: "red" });
    });
    wavesurfers[filename].load(root + "wav/" + filename);
    wavesurfers[filename].on("seek", () => {
      // work out current alignment grid index
      const currentGridIx =
        alignmentGrids[filename].findIndex(
          (n) => n > wavesurfers[filename].getCurrentTime()
        ) + 1;
      if (currentGridIx < 0) {
        // reset if can't find, e.g. because reached end
        currentGridIx = 0;
      }
      // iterate through all positionIndicatorCanvases, drawing in current ix position for that canvas
      const canvases = document.getElementsByClassName("position-indicator");
      Array.from(canvases).forEach((c) => {
        //c.width = c.width; // clear
        const file = c.closest(".waveform").dataset["ix"];
        const ctx = c.getContext("2d");
        const correspondingSeconds = alignmentGrids[file][currentGridIx];
        const duration = wavesurfers[file].getDuration();
        const absoluteX =
          (currentGridIx / alignmentGrids[filename].length) * c.width;
        const relativeX = (correspondingSeconds / duration) * c.width;
        const diffMapped = Math.floor((255 * (absoluteX - relativeX)) / 100);
        console.log(
          "abs: ",
          absoluteX,
          "rel: ",
          relativeX,
          "mapped: ",
          diffMapped
        );
        ctx.clearRect(0, 0, c.width, c.height);
        if(document.getElementById("visrelalign").checked) {
          ctx.beginPath();
          ctx.lineWidth = 2;
          ctx.moveTo(absoluteX, 0);
          ctx.lineTo(relativeX, c.height / 6);
          ctx.lineTo(relativeX, 5 * (c.height / 6));
          ctx.lineTo(absoluteX, c.height);
          ctx.strokeStyle =
            diffMapped < 0
              ? `rgb(${-1 * diffMapped} 100 100)`
              : `rgb(100 100 ${diffMapped})`;
          ctx.stroke();
        }
      });
    });
    wavesurfers[filename].on("ready", () => {
      // signal file is ready in filename list
      loaded.add(filename);
      console.log("READY:...", filename);
      // create alignment grid and position indicator canvases from waveform canvas
      const waveCanvas = document.querySelector(
        `.waveform[data-ix='${filename}']>wave>canvas`
      );
      const waveStyle = waveCanvas.style;
      const gridCanvas = document.createElement("canvas");
      const gridStyle = gridCanvas.style;
      const positionIndicatorCanvas = document.createElement("canvas");
      const positionIndicatorStyle = positionIndicatorCanvas.style;
      gridCanvas.classList.add("alignment-grid");
      gridCanvas.width = waveCanvas.width;
      gridCanvas.height = waveCanvas.height;
      gridStyle.zIndex = waveStyle.zIndex - 2;
      gridStyle.position = "absolute";
      gridStyle.top = waveStyle.top;
      gridStyle.left = waveStyle.left;
      gridStyle.bottom = waveStyle.bottom;
      gridStyle.right = waveStyle.right;
      gridStyle.display = document.getElementById("visalign").checked
        ? "unset"
        : "none";
      positionIndicatorCanvas.classList.add("position-indicator");
      positionIndicatorCanvas.width = waveCanvas.width;
      positionIndicatorCanvas.height = waveCanvas.height;
      positionIndicatorStyle.zIndex = waveStyle.zIndex - 1;
      positionIndicatorStyle.position = "absolute";
      positionIndicatorStyle.top = waveStyle.top;
      positionIndicatorStyle.left = waveStyle.left;
      positionIndicatorStyle.bottom = waveStyle.bottom;
      positionIndicatorStyle.right = waveStyle.right;
      //      positionIndicatorStyle.display = document.getElementById("visalign").checked ? "unset" : "none";
      waveCanvas.parentNode.insertBefore(gridCanvas, waveCanvas);
      waveCanvas.parentNode.insertBefore(positionIndicatorCanvas, waveCanvas);
      const canvasCtx = gridCanvas.getContext("2d");
      canvasCtx.lineWidth = 1;
      canvasCtx.strokeStyle = "#b0b0b055";
      // draw alignment grid
      // for each grid position, figure out x-coord by doing (seconds / duration) * canvas-width
      const duration = wavesurfers[filename].getDuration();
      // only draw every fifth position to prevent overplotting
      //alignmentGrids[filename].filter((_, ix) => ix % 5 === 0).forEach(gridPos => {
        /* HACK DLFM2023 remove indicator
      alignmentGrids[filename].forEach((gridPos, gridIx) => {
        // draw a vertical line in three segments:
        // first segment: ABSOLUTE GRID INDEX position
        // second segment: RELATIVE DURATION position
        // third segment: ABSOLUTE GRID INDEX position
        const absoluteX =
          (gridIx / alignmentGrids[filename].length) * gridCanvas.width;
        const relativeX = (gridPos / duration) * gridCanvas.width;
        const diffMapped = Math.floor((255 * (absoluteX - relativeX)) / 100);
        //canvasCtx.beginPath();
        //canvasCtx.strokeStyle = diffMapped < 0 ? `rgb(${-1*diffMapped} 0 0)` : `rgb(0 0 ${diffMapped})`;
        canvasCtx.moveTo(absoluteX, 0);
        canvasCtx.lineTo(relativeX, gridCanvas.height / 6);
        canvasCtx.lineTo(relativeX, 5 * (gridCanvas.height / 6));
        canvasCtx.lineTo(absoluteX, gridCanvas.height);
      });
      canvasCtx.stroke();
      */
      let listItem = document.getElementById(filename);
      let status = listItem.querySelector("label").classList;
      status.remove("loading");
      status.add("ready");
      listItem.querySelector("input").checked = true;
      // check if we're the currentAudioIx, and if so make ourselves active and spool to provided playPosition
      // (possible when normalize checkbox has forced a reload of waveform elements)
      if (filename === currentAudioIx) {
        document
          .querySelector(`.waveform[data-ix='${filename}']`)
          .classList.add("active");
        wavesurfers[currentAudioIx].play(playPosition);
        if (!isPlaying) {
          wavesurfers[currentAudioIx].pause();
        }
      }
      // restore marks from storage if they exist
      if (storage) {
        markersString = storage.getItem("markers_" + workId);
        if (markersString) {
          markers = JSON.parse(markersString);
          // apply any markers that may have been loaded from local storage
          markers.forEach((m) => {
            const t = getCorrespondingTime(filename, m);
            wavesurfers[filename].addMarker({ time: t, color: "red" });
          });
        }
      }
    });
    wavesurfers[filename].on("marker-click", (e) => {
      console.log("MARKER CLICKED");
      if (e.position === "top") {
        // ignore clicks on filename-label markers
        return;
      }
      // index into audio recordings for clicked marker's waveform
      const clickedAudioIx = e.el.closest(".waveform").dataset.ix;
      // get corresponding wavesurfer object
      const clickedSurfer = wavesurfers[clickedAudioIx];
      // look up alignment grid for this audio recording
      const clickedGrid = alignmentGrids[clickedAudioIx];
      // find the index of the time-value corresponding to the clicked marker in this grid
      const alignmentIx = clickedGrid.indexOf(e.time);
      if (alignmentIx > -1) {
        // delete the markers corresponding to this alignment index
        markers.splice(markers.indexOf(alignmentIx), 1);
        // update markers in storage, if possible
        if (storage) {
          storage.setItem("markers_" + workId, JSON.stringify(markers));
        }
        // redraw (remaining) markers for all waveforms
        Object.keys(wavesurfers).forEach((ws) => {
          wavesurfers[ws].clearMarkers();
          wavesurfers[ws].addMarker({
            time: 0,
            label: ws,
            color: "black",
            position: "top",
          });
          markers.forEach((m) => {
            // get time corresponding to the marker for this audio
            const t = getCorrespondingTime(ws, m);
            // draw marker at this time
            wavesurfers[ws].addMarker({ time: t, color: "red" });
          });
        });
      } else {
        console.error("Could not find grid entry for time ", e.time);
      }
    });
    wavesurfers[filename].on("seek", (e) => {
      if (filename !== currentAudioIx) swapCurrentAudio(filename);
    });
    wavesurfers[filename].on("audioprocess", () => {
      // continually update timer region when opened but not yet closed
      if (timerFrom === timerTo && timerFrom > 0) {
        wavesurfers[filename].regions.list.timer.end =
          wavesurfers[filename].getCurrentTime();
        updateRenderTimer();
      }
    });

    // render anno regions
    if (currentlyAnnotatedRegions) updateRenderAnnoRegions();
  } else {
    // waveform already loaded...
    let checkbox = document.getElementById(filename).querySelector("input");
    if (!checkbox.checked) {
      // if hidden, unhide by clicking on checkbox
      checkbox.click();
    }
    // now swap to the audio
    swapCurrentAudio(filename);
  }
}

function setGrids(grids) {
  console.log("received grids: ", grids);
  if ("body" in grids) {
    if ("audio" in grids.body) {
      // final version of alignment json
      alignmentGrids = grids.body.audio;
      if ("header" in grids) {
        if ("meiUri" in grids.header && "score" in grids.body) {
          meiUri = grids.header.meiUri;
          scoreAlignment = grids.body.score;
          fetch(meiUri)
            .then((response) => response.text())
            .then((mei) => {
              tk.loadData(mei, {});
              timemap = tk.renderToTimemap({});
              console.log("timemap set!", timemap, mei);
            })
            .catch((e) => {
              console.error("Couldn't load MEI: ", e, grids.header.meiUri);
            });
        }
        if ("ref" in grids.header) {
          referenceAudioIx = grids.header.ref;
        }
      } else {
        console.error(
          "Broken grids received from alignment json file: ",
          grids
        );
      }
    } else {
      // pre-final dev version of alignment json
      alignmentGrids = grids.body;
    }
  } else {
    // old version of alignment json
    alignmentGrids = grids;
  }
  console.log("setting grids: ", grids);
  /* separate VPO, external, and other */
  /* for now, hackily use filenames */
  /* in glorious future, use knowledge graph */
  let filenames = Object.keys(alignmentGrids);
  let vpoFiles = filenames.filter((n) =>
    n.substr(n.lastIndexOf("/") + 1).startsWith("VPO-")
  );
  let extFiles = filenames.filter((n) => 
    n.substr(n.lastIndexOf("/") + 1).startsWith("ext-")
  );
  vpoFiles = vpoFiles.sort();
  extFiles = extFiles.sort();
  let otherFiles = filenames.filter((n) => !vpoFiles.includes(n) && !extFiles.includes(n)).sort();
  otherFiles = otherFiles.sort();

  const vpoList = generateCheckboxList(vpoFiles);
  const otherList = generateCheckboxList(otherFiles);
  const extList = generateCheckboxList(extFiles);

  const listSelectors = `<span class='listSelectors'>
    <span class='all'>All</span><span class='none'>None</span>
  </span>`;

  const vpoFoldout = document.createElement("details");
  const vpoSummary = document.createElement("summary");

  vpoSummary.innerText = "VPO";
  vpoFoldout.appendChild(vpoSummary);
  vpoFoldout.innerHTML += listSelectors;
  vpoFoldout.appendChild(vpoList);

  const otherFoldout = document.createElement("details");
  const otherSummary = document.createElement("summary");
  otherSummary.innerText = "Other";
  otherFoldout.appendChild(otherSummary);
  otherFoldout.innerHTML += listSelectors;
  otherFoldout.appendChild(otherList);

  const extFoldout = document.createElement("details");
  const extSummary = document.createElement("summary");

  extSummary.innerText = "External";
  extFoldout.appendChild(extSummary);
  extFoldout.innerHTML += listSelectors;
  extFoldout.appendChild(extList);

  const audiosElement = document.getElementById("audios");

  vpoFoldout.open = true;
  otherFoldout.open = true;
  extFoldout.open = true;

  audiosElement.appendChild(vpoFoldout);
  audiosElement.appendChild(otherFoldout);
  audiosElement.appendChild(extFoldout);

  // list selectors
  Array.from(document.querySelectorAll(".listSelectors .all")).forEach(
    (selector) =>
      selector.addEventListener("click", (e) => {
        let checkboxes = Array.from(
          e.target.closest("details").querySelectorAll("input")
        );
        checkboxes.forEach((cb) => {
          // we're doing work in clickhandlers, so can't just set checked value
          if (!cb.checked) cb.click();
        });
      })
  );
  Array.from(document.querySelectorAll(".listSelectors .none")).forEach(
    (selector) =>
      selector.addEventListener("click", (e) => {
        let checkboxes = Array.from(
          e.target.closest("details").querySelectorAll("input")
        );
        checkboxes.forEach((cb) => {
          // we're doing work in clickhandlers, so can't just unset checked value
          if (cb.checked) cb.click();
        });
      })
  );

  // rendition selectors
  Array.from(document.getElementsByClassName("renditionName")).forEach(
    (r, ix) => {
      r.addEventListener("click", onClickRenditionName);
    }
  );
  Array.from(document.getElementsByClassName("renditionCheckbox")).forEach(
    (r, ix) => {
      r.addEventListener("click", onClickRenditionCheckbox);
    }
  );
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("back").addEventListener("click", () => {
    // TODO hack for DH 2023, improve
    solidLogout().then(
      () =>
        (window.location.href = window.location.href.substr(
          0,
          window.location.href.indexOf("/listen")
        ))
    );
  });
  if (storage.restoreSolidSession) {
    // attempt to restore Solid session with fresh data
    loginAndFetch();
  }
  // draw appropriate solid authorization message
  populateSolidTab();

  // set up Verovio
  verovio.module.onRuntimeInitialized = () => {
    tk = new verovio.toolkit();
    console.log("Have Verovio toolkit:", tk);
  };

  // load alignment json
  fetch(alignmentData)
    .then((response) => response.json())
    .then((contents) => {
      setGrids(contents);
    })
    .catch((err) => console.warn("Couldn't load alignment data: ", err));

  // load a colormap json file to be passed to the spectrogram.create method.
  WaveSurfer.util
    .fetchFile({ url: root + "js/hot-colormap.json", responseType: "json" })
    .on("success", (cM) => {
      colorMap = cM;
    });
  // play/pause button
  document.getElementById("playpause").addEventListener("click", function (e) {
    playpause();
  });
  // mark button
  document.getElementById("mark").addEventListener("click", function (e) {
    let toMark = getClosestAlignmentIx();
    markers.push(toMark);
    // update markers in storage, if possible
    if (storage) {
      storage.setItem("markers_" + workId, JSON.stringify(markers));
    }
    Object.keys(wavesurfers).forEach((ws) => {
      const t = getCorrespondingTime(ws, toMark);
      console.log("got corresponding time: ", t);
      wavesurfers[ws].addMarker({ time: t, color: "red" });
    });
  });
  // play from last marker button
  document.getElementById("playLastMark").addEventListener("click", () => {
    seekToLastMark();
    wavesurfers[currentAudioIx].play();
  });

  // show spectrograms checkbox
  document.getElementById("showSpectrograms").checked = false;
  document.getElementById("showSpectrograms").addEventListener("click", (e) => {
    let waveforms = document.getElementById("waveforms");
    if (e.target.checked) {
      waveforms.classList.add("showSpectrograms");
    } else {
      waveforms.classList.remove("showSpectrograms");
    }
  });

  // normalize audio checkbox
  document.getElementById("normalize").checked = false;
  document.getElementById("normalize").addEventListener("click", (e) => {
    reloadWaveforms();
  });
  // visualize alignment checkbox
  document.getElementById("visalign").checked = false;
  document.getElementById("visalign").addEventListener("click", (e) => {
    let display = e.target.checked ? "unset" : "none";
    Array.from(document.querySelectorAll(".alignment-grid")).forEach(
      (e) => (e.style.display = display)
    );
  });

  document.querySelector("body").addEventListener("keypress", (e) => {
    e.preventDefault();
    console.log("KEYPRESS: ", e);
    if (currentAudioIx) {
      let updateTimer = false;
      console.log(wavesurfers[currentAudioIx].regions.list);
      switch (e.code) {
        case "KeyT":
          // HACK FOR DH 2023 temporarily disable in this branch
          return false;
          if (timerFrom > 0 && timerFrom === timerTo) {
            console.log("mid");
            timerTo = wavesurfers[currentAudioIx].getCurrentTime();
          } else {
            console.log("start");
            timerFrom = wavesurfers[currentAudioIx].getCurrentTime();
            timerTo = timerFrom;
          }
          updateTimer = true;
          break;
        case "KeyX":
          // release timer
          timerFrom = 0;
          timerTo = 0;
          updateTimer = true;
          break;
        case "Space":
          // space bar
          playpause();
          break;
      }
      if (updateTimer) {
        // walk through all other displayed wavesurfers and cross-apply...
        Object.keys(wavesurfers).forEach((ws) => {
          const wsFrom = getCorrespondingTime(
            ws,
            getClosestAlignmentIx(timerFrom)
          );
          const wsTo = getCorrespondingTime(ws, getClosestAlignmentIx(timerTo));
          wavesurfers[ws].regions.list.timer.start = wsFrom;
          wavesurfers[ws].regions.list.timer.end = wsTo;
          console.log("SET TIMER: ", wavesurfers[ws].regions.list.timer, ws);
        }); /*
        wavesurfers[currentAudioIx].regions.list.timer.start = timerFrom;
        wavesurfers[currentAudioIx].regions.list.timer.end = timerTo;
        */
        updateRenderTimer();
      }
    }
  });
});

export function markScoreRegion(ids, selectionUrl, reset = false) {
  if(reset) { 
    currentlyAnnotatedRegions = [];
  }
  console.log("Marking score region for ids: ", ids);
  // iterate over ids, attempting to find the first and last note that the tk can getTimesForElements on
  if (scoreAlignment && tk && referenceAudioIx) {
    let fromId, toId;
    let fromTimes, toTimes;
    for (let id of ids) {
      fromTimes = tk.getTimesForElement(id);
      if (Object.keys(fromTimes).length) {
        fromId = id;
        break;
      }
    }
    for (let id of ids.reverse()) {
      toTimes = tk.getTimesForElement(id);
      if (Object.keys(toTimes).length) {
        toId = id;
        break;
      }
    }
    if (fromTimes) {
      let onsets = fromTimes.realTimeOnsetMilliseconds;
      // if no toId specified, mark region from onset to offset of fromId; otherwise, mark from onset of fromId to offset of toId
      let offsets = toTimes
        ? toTimes.realTimeOffsetMilliseconds
        : fromTimes.realTimeOffsetMilliseconds;
      // getTimesForElements returns onset and offset times for identified elements (plus other stuff)
      // The returned values are arrays, to handle expansions. So we have to handle the arrays.
      // Return regions in the reference audio corresponding to these onsets and offsets
      console.log("fromId: ", fromId, "toId: ",toId, "fromTimes", fromTimes, "toTimes", toTimes,"onsets: ", onsets, "offsets: ", offsets);
      let refRegions = onsets.map((t, expansionIx) => {
        console.log("In loop: ", t, expansionIx);
        return {
          from: scoreAlignment.ref_onset[
            getClosestScoreTimeIx(t, scoreAlignment.score_onset)
          ],
          to: scoreAlignment.ref_offset[
            getClosestScoreTimeIx(
              offsets[expansionIx],
              scoreAlignment.score_offset
            )
          ],
        };
      });
      // convert to alignment ix
      currentlyAnnotatedRegions.push({
        selection : selectionUrl.href,
        from: getClosestAlignmentIx(refRegions[0].from, referenceAudioIx),
        to: getClosestAlignmentIx(refRegions[0].to, referenceAudioIx),
      });
      updateRenderAnnoRegions();
      /* HACK DH 2023, in future handle multiple regions, for now only use the first
      /*refRegions.map(r => { 
        return {
          from: getClosestAlignmentIx(r.from, referenceAudioIx), 
          to: getClosestAlignmentIx(r.to, referenceAudioIx)
        }
      });*/
    } else {
      console.warn(
        "Verovio couldn't find onset / offset times for any of the selection IDs. Were any notes selected?"
      );
    }
  } else {
    console.warn("Current alignment JSON does not support score alignment");
  }
}

function getClosestScoreTimeIx(tInMilliSec, times) {
  let t = tInMilliSec / 1000;
  let closest = times.reduce(function (prev, curr) {
    return Math.abs(curr - t) < Math.abs(prev - t) ? curr : prev;
  });
  return times.indexOf(closest);
}

function playpause() {
  if (currentAudioIx) {
    if (wavesurfers[currentAudioIx].isPlaying())
      wavesurfers[currentAudioIx].pause();
    else wavesurfers[currentAudioIx].play();
  } else {
    // if there is at least one waveform loaded, make it active and play it
    let firstWs = document.querySelector(".waveform");
    if (firstWs) {
      swapCurrentAudio(firstWs.dataset.ix);
      wavesurfers[currentAudioIx].play();
    }
  }
}

function updateRenderTimer() {
  Object.keys(wavesurfers).forEach((ws) => {
    let timer = wavesurfers[ws].regions.list.timer;
    console.log(timer.start, timer.end);
    timer.updateRender();
    let timeDelta = timer.end - timer.start;
    document.querySelector(
      '.waveform[data-ix="' + ws + '"] region[data-id="timer"]'
    ).innerHTML = timeDelta
      ? `<div class='timerValueContainer'><span>${timeDelta.toFixed(
          3
        )}</span></div>`
      : ""; // don't display 0
  });
}

// todo refactor with updateRenderTimer above
function updateRenderAnnoRegions() {
  // HACK dlfm2023: for now do nothing, ensure annots are loaded before wavesurfers
  Object.keys(wavesurfers).forEach((ws) => {
    console.log("Update render anno regions: ", ws, currentlyAnnotatedRegions);
    let regions = extractCurrentlyAnnotatedRegions(ws);
    wavesurfers[ws].clearRegions();
    regions.forEach(r => wavesurfers[ws].addRegion(r));

      /*
      let timeDelta = region.end - region.start;
      document.querySelector('.waveform[data-ix="' + ws + '"] region[data-id="anno_region_0"]')
        .innerHTML = timeDelta 
          ? `<div class='regiontimerValueContainer'><span>${timeDelta.toFixed(3)}</span></div>` 
          : ""; // don't display 0 */
  });
}


function extractCurrentlyAnnotatedRegions(ws) { 
  return currentlyAnnotatedRegions.map((r, ix) => {
    return {
        id: "anno_region_" + ix,
        start: getCorrespondingTime(ws, r.from),
        end: getCorrespondingTime(ws, r.to),
        drag: false,
        resize: false,
        color: "rgba(200, 130, 80, 0.3)"
      }
  });
}