let wavesurfers = {};
let markers = [];
let loaded = new Set();
let alignmentgrids = {};
let ref;
let currentaudioix = "";
let storage;
let colormap;
try { 
  storage = window.localstorage;
} catch(err) { 
  console.warn("unable to access local storage: ", err);
}


function seekToLastMark() { 
  if(markers.length) { 
    const currentAlignmentIx = getClosestAlignmentIx();
    const prevMarkers = markers.filter(m => m <= currentAlignmentIx);
    let lastMarker;
    if(prevMarkers.length) 
      lastMarker = prevMarkers[prevMarkers.length-1]
    else
      lastMarker = 0;
    wavesurfers[currentAudioIx].seekTo(
      getCorrespondingTime(currentAudioIx, lastMarker) / 
      wavesurfers[currentAudioIx].getDuration()
    )
  }
}

function getClosestAlignmentIx(time = wavesurfers[currentAudioIx].getCurrentTime()) { 
  // return alignment index closest to supplied time (default: current playback position)
  let currentGrid = alignmentGrids[currentAudioIx]
  // find the nearest marker to current playback time
  const lower = currentGrid.filter(t => t <= time);
  // ix for closest marker below current time
  let closestAlignmentIx = lower.length;
  // if next marker (closest above current time) is closer, switch to it
  if(closestAlignmentIx < currentGrid.length && 
     time - currentGrid[closestAlignmentIx] > 
      currentGrid[closestAlignmentIx+1])  
          closestAlignmentIx += 1;
  return closestAlignmentIx;
}

function getCorrespondingTime(audioIx, alignmentIx) { 
  // get time position corresponding to current position of current audio, 
  // in the alternative audio with index audioIx
  let grid = alignmentGrids[audioIx];
  console.log("Looking up ", alignmentIx, " in ", grid);
  return grid[alignmentIx];
}

function onClickRenditionName(e) { 
  // Catches clicks on checkboxes or labels
  // Used to load / switch to the respective rendition
  let checkbox;
  if(e.target.nodeName.toLowerCase() === "label") { 
    // retrieve checkbox
    checkbox = document.getElementById(e.target.for);
  } else if(e.target.nodeName.toLowerCase === "li"){ 
    checkbox = e.target.querySelector("input");
  } else { 
    checkbox = e.target;
  }
  console.log("CLick: ", e)
  console.log("Checkbox: ", checkbox)

  if(checkbox.value) { 
    const status = document.getElementById(checkbox.value)
      .querySelector("label").classList;
    if(!(status.contains("ready")) && !(status.contains("loading"))) {
      status.add("loading");
    }
    prepareWaveform(checkbox.value);
    console.log("Clicked!", checkbox.value)
  }
}

function onClickRenditionCheckbox(e)  {
  // n.b. separate handler to onClickRenditionName
  // used only to specifically show/hide renditions when  
  // they have already loaded
  let checkbox = e.target;
  let checked = checkbox.checked;
  let label = checkbox.parentElement.querySelector("label");
  let waveform = document.getElementById("waveform-"+ e.target.value + "-wav");
  let spectrogram = document.getElementById("waveform-"+ e.target.value+"-spec");
  if(!checked) { 
    e.stopPropagation(); // hide from other handler
    waveform.style.display = "none";
    spectrogram.style.display = "none";
    checkbox.checked = false;
    label.classList.remove("ready");
    label.classList.add("loading");
  } else if(label.classList.contains("loading")) { 
    e.stopPropagation(); // hide from other handler
    waveform.style.display = "unset";
    if(document.getElementById("showSpectrograms").checked) 
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
  if(currentAudioIx === newAudio) { 
    // no need to swap
    return;
  }
  if(currentAudioIx) { 
    console.log("Pausing current: ", currentAudioIx);
    console.log("Current duration: ", wavesurfers[currentAudioIx].getDuration());
    const wasPlaying = wavesurfers[currentAudioIx].isPlaying();
    wavesurfers[currentAudioIx].pause();
    let closestAlignmentIx = getClosestAlignmentIx();
    document.getElementById(`waveform-${currentAudioIx}`+"-wav").classList.remove("active");
    // swap to new audio and alignment grid
    currentAudioIx = newAudio;
    console.log("new audio ix: ", currentAudioIx);
    let currentGrid = alignmentGrids[currentAudioIx]
    console.log("new audio grid: ", alignmentGrids[currentAudioIx]);
    console.log("new duration: ", wavesurfers[currentAudioIx].getDuration());
    let newWaveform = document.getElementById(`waveform-${currentAudioIx}`+"-wav");
    // highlight as active
    newWaveform.classList.add("active");
    // scroll to position
    let bbox = newWaveform.getBoundingClientRect();
    let waveforms = document.getElementById("waveforms");
    waveforms.scrollTo({
      top: bbox.top + waveforms.scrollTop - 128,
      left: 0,
      behavior: "smooth"
    });
    // seek to new (corresponding) position 
    transitionToLastMark = document.getElementById(`transitionType`).checked;
    console.log("transitionToLastMark: ", transitionToLastMark)
    let correspondingPosition = currentGrid[closestAlignmentIx];
    let newPosition = correspondingPosition / wavesurfers[currentAudioIx].getDuration();
    wavesurfers[currentAudioIx].seekTo(newPosition);
    if(transitionToLastMark) { 
      seekToLastMark();
    }   
    if(wasPlaying)
      wavesurfers[currentAudioIx].play();
  } else { 
    currentAudioIx = newAudio;
    const newActiveWaveform = document.getElementById(`waveform-${currentAudioIx}`+"-wav");
    if(newActiveWaveform) { 
      newActiveWaveform.classList.add("active");
    }
  }
}

function generateCheckboxList(list) {
  // generate content for <ul>:
  // <li> containing a checkbox for each list member
  const ul = document.createElement("ul");
  list.forEach(n => { 
    const li = document.createElement("li");
    li.classList.add("renditionName");
    li.id = n;
    const checkboxSpan = document.createElement("span");
    const checkbox = document.createElement("input")
    checkbox.id = "checkbox-" + n;
    checkbox.name = "checkbox-" + n;
    checkbox.type = "checkbox";
    checkbox.classList.add("renditionCheckbox");
    checkbox.value = n;
    const label = document.createElement("label");
    label.for="checkbox-" + n;
    label.innerText = n.substr(n.indexOf("/")+1); // HACK, use semantic title
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
  if(currentAudioIx) {
    playPosition = wavesurfers[currentAudioIx].getCurrentTime();
    isPlaying = wavesurfers[currentAudioIx].isPlaying();
  }
  // get current play position of active wavesurfer
  // destroy current wavesurfers
  prevLoaded.forEach(ws => wavesurfers[ws].destroy());
  wavesurfers = {};
  // forget waveform elements (and spectorgrams)
  document.getElementById("waveforms").replaceChildren();
  // re-create previously loaded waveforms
  prevLoaded.forEach(ws => prepareWaveform(ws, playPosition, isPlaying));
}

function visualiseAlignments() { 
  // go through all wavesurfers, throw out user-defined markers, and instead draw in alignment positions as markers
  Object.keys(wavesurfers).forEach(ws => { 
    wavesurfers[ws].clearMarkers();
    alignmentGrids[ws].forEach(t => { 
      wavesurfers[ws].addMarker({ time: t, color: "green" });
      wavesurfers[ws].on("hover", (e) => { 
        console.log("HOVER: ", e)
      })
    })
  })
}

function prepareWaveform(filename, playPosition = 0, isPlaying = false) { 
  // if not yet created, do so:
  if(!(filename in wavesurfers)) { 
    const waveform = document.createElement("div");
    waveform.id = "waveform-"+filename+"-wav";
    waveform.dataset.ix = filename;
    waveform.classList.add("waveform");
    const spectrogram = document.createElement("div");
    spectrogram.id = "waveform-"+filename+"-spec";
    spectrogram.dataset.ix = filename;
    spectrogram.classList.add("spectrogram");
    let waveforms = document.getElementById("waveforms");
    // add elements to waveforms
    waveforms.appendChild(spectrogram);
    waveforms.appendChild(waveform);
    // now resort waveforms to maintain order, prioritizing VPO
    let vpo = [...waveforms.children].filter(n => n.id.substr(n.id.lastIndexOf("/")+1).startsWith("VPO-"));
    let other = [...waveforms.children].filter(n => !(n.id.substr(n.id.lastIndexOf("/")+1).startsWith("VPO-")));
    vpo.sort((a,b) => a.id > b.id?1:-1).forEach(node=>waveforms.appendChild(node));
    other.sort((a,b) => a.id > b.id?1:-1).forEach(node=>waveforms.appendChild(node));
    // create new wavesurfer instance in the new container
    wavesurfers[filename] = WaveSurfer.create({
      container: `#${CSS.escape("waveform-"+filename)+"-wav"}`,
      waveColor: "violet",
      progressColor: "purple",
      normalize: document.getElementById("normalize").checked,
      plugins: [ 
        WaveSurfer.markers.create({}), 
        WaveSurfer.spectrogram.create({
          wavesurfer: wavesurfers[filename],
          container: (`#${CSS.escape("waveform-"+filename+"-spec")}`),
          labels: true,
          colorMap: colorMap,
          height: 128
        })
      ]
    });
    // add filename label marker
    wavesurfers[filename].addMarker({
      time: 0,
      label: filename,
      color:"black",
      position:"top"
    })
    // add any user-generated markers
    markers.forEach(m => { 
      const t = getCorrespondingTime(filename, m);
      wavesurfers[filename].addMarker({time: t, color:"green"});
    })
    wavesurfers[filename].load(root + "wav/" + filename);
    wavesurfers[filename].on("ready", () => {
      // signal file is ready in filename list
      loaded.add(filename);
      console.log("READY:", filename);/*
      const canvas = document.querySelector(`.waveform[data-ix='${filename}']`).querySelector('canvas');
      const canvasCtx = canvas.getContext('2d');
      console.log("COntext: ", canvasCtx);
      // draw alignment grid
      // for each grid position, figure out x-coord by doing (seconds / duration) * canvas-width
      const duration = wavesurfers[filename].getDuration();
      alignmentGrids[filename].forEach(gridPos => { 
        const x = (gridPos / duration) * canvas.width;
        canvasCtx.moveTo(x, 0);
        canvasCtx.lineTo(x, canvas.height);
      });
      canvasCtx.stroke();*/
      let listItem = document.getElementById(filename);
      let status = listItem.querySelector("label").classList;
      status.remove("loading");
      status.add("ready");
      listItem.querySelector("input")
        .checked = true;
      // check if we're the currentAudioIx, and if so make ourselves active and spool to provided playPosition
      // (possible when normalize checkbox has forced a reload of waveform elements)
      if(filename === currentAudioIx) { 
        document.querySelector(`.waveform[data-ix='${filename}']`).classList.add("active");
        wavesurfers[currentAudioIx].play(playPosition);
        if(!isPlaying) { 
          wavesurfers[currentAudioIx].pause();
        }
      }
    });
    wavesurfers[filename].on("marker-click", (e) => {
      if(e.position === "top") { 
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
      if(alignmentIx > -1) { 
        // delete the markers corresponding to this alignment index
        markers.splice(markers.indexOf(alignmentIx), 1);
        // update markers in storage, if possible
        if(storage) {
          storage.setItem("markers", JSON.stringify(markers));
        }
        // redraw (remaining) markers for all waveforms
        Object.keys(wavesurfers).forEach((ws) => {
          wavesurfers[ws].clearMarkers();
          wavesurfers[ws].addMarker({
            time: 0,
            label: ws,
            color:"black",
            position:"top"
          })
          markers.forEach(m => {
            // get time corresponding to the marker for this audio
            const t = getCorrespondingTime(ws, m);
            // draw marker at this time
            wavesurfers[ws].addMarker({time: t, color:"green"});
          })
        })
      } else { 
        console.error("Could not find grid entry for time ", e.time);
      }
    });
    wavesurfers[filename].on("seek", (e) => { 
      if(filename !== currentAudioIx)
        swapCurrentAudio(filename);
    });
  } else {
    // waveform already loaded...
    let checkbox = document.getElementById(filename).querySelector("input");
    if(!(checkbox.checked)) { 
      // if hidden, unhide by clicking on checkbox
      checkbox.click();
    }
    // now swap to the audio
    swapCurrentAudio(filename);
  }
}

function setGrids(grids) { 
  console.log("setting grids: ", grids);
  alignmentGrids = grids;
  /* separate VPO and other */
  /* for now, hackily use filenames */
  /* in glorious future, use knowledge graph */
  let filenames = Object.keys(grids);
  let vpoFiles = filenames.filter(n => n.substr(n.lastIndexOf("/")+1).startsWith("VPO-"));
  vpoFiles = vpoFiles.sort();
  let otherFiles = filenames.filter(n => !vpoFiles.includes(n)).sort();
  otherFiles = otherFiles.sort();

  const vpoList = generateCheckboxList(vpoFiles);
  const otherList = generateCheckboxList(otherFiles);

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

  const audiosElement = document.getElementById("audios");

  vpoFoldout.open = true;
  otherFoldout.open = true;

  audiosElement.appendChild(vpoFoldout);
  audiosElement.appendChild(otherFoldout);

  // list selectors
  Array.from(document.querySelectorAll('.listSelectors .all'))
    .forEach(selector => selector.addEventListener('click', (e) => {
      let checkboxes = Array.from(e.target.closest("details").querySelectorAll("input"));
      checkboxes.forEach(cb => { 
        // we're doing work in clickhandlers, so can't just set checked value
        if(!(cb.checked))
          cb.click();
      })
    }));
  Array.from(document.querySelectorAll('.listSelectors .none'))
    .forEach(selector => selector.addEventListener('click', (e) => {
      let checkboxes = Array.from(e.target.closest("details").querySelectorAll("input"));
      checkboxes.forEach(cb => { 
        // we're doing work in clickhandlers, so can't just unset checked value
        if(cb.checked)
          cb.click();
      })
    }));
  
  // rendition selectors
  Array.from(document.getElementsByClassName("renditionName"))
    .forEach((r, ix) => {
      r.addEventListener("click", onClickRenditionName);
    });
  Array.from(document.getElementsByClassName("renditionCheckbox"))
    .forEach((r, ix) => {
      r.addEventListener("click", onClickRenditionCheckbox);
    });
}
document.addEventListener('DOMContentLoaded', () => {
  // load alignment json 
  fetch(alignmentData)
    .then(response => response.json())
    .then(contents => {
      setGrids(contents);
    })
    .catch(err => console.warn("Couldn't load alignment data: ", err));

    // load a colormap json file to be passed to the spectrogram.create method.
  WaveSurfer.util
      .fetchFile({ url: root + 'js/hot-colormap.json', responseType: 'json' })
      .on('success', cM => {
        colorMap = cM;
      });
  // play/pause button
  document.getElementById("playpause").addEventListener('click', function(e){
    if(wavesurfers[currentAudioIx].isPlaying()) 
      wavesurfers[currentAudioIx].pause();
    else 
      wavesurfers[currentAudioIx].play();
  });
  // mark button
  document.getElementById("mark").addEventListener('click', function(e){
    let toMark = getClosestAlignmentIx();
    markers.push(toMark);
    // update markers in storage, if possible
    if(storage) {
      storage.setItem("markers", JSON.stringify(markers));
    }
    Object.keys(wavesurfers).forEach((ws) =>  {
      const t = getCorrespondingTime(ws, toMark);
      console.log("got corresponding time: ",t) 
      wavesurfers[ws].addMarker({time: t, color:"green"})
    })
  });
  // restore button
  document.getElementById("restore").addEventListener('click', function(e){
    // recover marker positions from local storage if possible
    if(storage) { 
      markersString = storage.getItem("markers");
      if(markersString) {
        markers = JSON.parse(markersString);
        wavesurfers.forEach((ws, wsIx) => {
          // apply any markers that may have been loaded from local storage
          markers.forEach(m => { 
            const t = getCorrespondingTime(wsIx, m);
            wavesurfers[wsIx].addMarker({time: t, color:"green"});
          })
        })
      }
    }
  });
  // play from last marker button
  document.getElementById("playLastMark").addEventListener('click', () => { 
    seekToLastMark();
    wavesurfers[currentAudioIx].play();
  });

  // show spectrograms checkbox
  document.getElementById("showSpectrograms").checked = false;
  document.getElementById("showSpectrograms").addEventListener('click', (e) => { 
    let waveforms = document.getElementById("waveforms");
    if(e.target.checked) {
      waveforms.classList.add("showSpectrograms");
    }
    else {
      waveforms.classList.remove("showSpectrograms");
    }
  });

  // normalize audio checkbox
  document.getElementById("normalize").checked = false;
  document.getElementById("normalize").addEventListener('click', (e) => { 
    reloadWaveforms();
  });
  // visualize alignment checkbox
  document.getElementById("visalign").checked = false;
  document.getElementById("visalign").addEventListener('click', (e) => { 
    const canvases = Array.from(document.querySelectorAll(".waveform>wave>canvas"));
    console.log("Canvases: ", canvases)
    canvases.forEach(canvas => { 
      const filename = canvas.closest(".waveform").dataset['ix'];
      const canvasCtx = canvas.getContext('2d');
      console.log("COntext: ", canvasCtx);
      // draw alignment grid
      // for each (nth) grid position, figure out x-coord by doing (seconds / duration) * canvas-width
      const duration = wavesurfers[filename].getDuration();
      // for each 10th position, to avoid overfitting
      alignmentGrids[filename].filter((_, ix) => ix % 10 === 0).forEach(gridPos => { 
        const x = (gridPos / duration) * canvas.width;
        canvasCtx.moveTo(x, 0);
        canvasCtx.lineTo(x, canvas.height);
        canvasCtx.stroke();
      });
    })
    markButton = document.getElementById("mark");
    markButton.disabled = !!e.target.checked; // disable marks if visualising alignments
    if(e.target.checked) { 
    //  visualiseAlignments();
    } else { 
     // document.getElementById("restore").click();
    }

  });

})
