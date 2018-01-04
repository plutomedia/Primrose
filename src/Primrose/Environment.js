/*
pliny.class({
  parent: "Primrose",
  name: "Environment",
  description: "Make a Virtual Reality app in your web browser!\n\
\n\
The `Environment` class provides a plethora of options for setting up new scenes and customizing the VR experience to your system. It is the starting point for all of your projects. It is named `Environment` as one day their may be an `AltspaceVREnvironment` or a `HiFidelityEnvironment`.",
  parameters: [{
    name: "options",
    type: "Primrose.Environment.optionsHash",
    description: "Settings to change how the environment looks and behaves. See [`Primrose.Environment.optionsHash`](#Primrose_Environment_optionsHash) for more information."
  }]
});
*/

import { hub } from "../live-api";

import {
  identity,
  Angle,
  documentReady,
  coalesce
} from "../util";

import Pointer from "./Pointer";
import Keys from "./Keys";

import {
  updateAll,
  eyeBlankAll
} from "./Controls/BaseTextured";

import Image from "./Controls/Image";

import StandardMonitorVRDisplay from "./Displays/StandardMonitorVRDisplay";

import { cascadeElement } from "./DOM";

import {
  Keyboard,
  Mouse,
  Touch,
  VR
} from "./Input";

import {
  Quality,
  PIXEL_SCALES
} from "./constants";

import {
  EventDispatcher,
  Scene,
  PerspectiveCamera,
  Quaternion,
  Color,
  Euler,
  Vector3,
  Matrix4,
  WebGLRenderer
} from "three";


const MILLISECONDS_TO_SECONDS = 0.001,
  TELEPORT_DISPLACEMENT = new Vector3(),
  DISPLACEMENT = new Vector3(),
  EULER_TEMP = new Euler(),
  QUAT_TEMP = new Quaternion(),
  WEDGE = Math.PI / 3;

export default class Environment extends EventDispatcher {
  constructor(options) {
    super();

    /*
    pliny.property({
      parent: "Primrose.Environment",
      name: "options",
      type: "Object",
      description: "Options used to build the environment."
    });
    */
    this.options = coalesce({}, Environment.DEFAULTS, options);

    this.options.foregroundColor = this.options.foregroundColor || complementColor(new Color(this.options.backgroundColor))
      .getHex();

    this.deltaTime = 1;

    /*
    pliny.property({
      name: "plugins",
      type: "Array",
      description: "An array of `Primrose.Plugin.BasePlugin`s that will modify the Environment. By carving this functionality into Plugins, it allows the implementing developer to keep their bundle size small by avoiding features they don't care to use."
    });
    */
    this.plugins = this.options.plugins;

    this.physics = null;
    this.entities = null;

    /*
    pliny.property({
      parent: "Primrose.Environment",
      name: "network",
      type: "Primrose.Network.Manager",
      description: "A manager for messages sent across the network."
    });
    */
    this.network = null;

    if(this.options.nonstandardIPD !== null){
      this.options.nonstandardIPD *= 0.5;
    }

    /*
    pliny.property({
      parent: "Primrose.Environment",
      name: "audioQueue",
      type: "Array",
      description: "Remote user Audio elements that joined as peers before the `Environment` could finish loading all of the assets."
    });
    */
    this.audioQueue = [];


    /*
    pliny.method({
      parent: "Primrose.Environment",
      name: "zero",
      description: "Zero and reset sensor data."
    });
    */
    this.zero = () => {
      if (!this.lockMovement) {
        for (let i = 0; i < this.managers.length; ++i) {
          this.managers[i].zero();
        }
        if (this.quality === Quality.NONE) {
          this.quality = Quality.HIGH;
        }
      }
    };

    let missedFrames = 0,
      accumTime = 0;

    const update = (dt) => {

      dt = Math.min(1, dt * MILLISECONDS_TO_SECONDS);
      if(dt > 0) {
        accumTime += dt;
        const fps = Math.max(1, Math.round(1 / dt));
        this.deltaTime = Math.min(this.deltaTime, 1 / fps);


        // if we missed way too many frames in one go, just update once, otherwise we'll end up locking up the system.
        let numFrames = accumTime / this.deltaTime;
        missedFrames += numFrames - 1;
        if(numFrames > 10) {
          numFrames = 1;
          accumTime = this.deltaTime;
        }


        if(missedFrames > 0) {
          if(missedFrames >= 10 && dt < 1) {
            this.deltaTime = dt;
            missedFrames = 0;
          }
          if(numFrames === 1) {
            missedFrames -= 0.1;
          }
        }

        for(let i = 0; i < this.plugins.length; ++i) {
          this.plugins[i].preUpdate(this, dt);
        }

        for(let frame = 0; frame < numFrames; ++frame) {

          accumTime -= this.deltaTime;

          const hadGamepad = this.hasGamepad;
          for (let i = 0; i < this.managers.length; ++i) {
            this.managers[i].update(dt);
          }
          if (!hadGamepad && this.hasGamepad) {
            this.Mouse.inPhysicalUse = false;
          }

          this.head.showPointer = this.VR.hasOrientation && this.VR.isStereo && this.options.showHeadPointer;
          this.mousePointer.visible = (this.VR.isPresenting || !this.VR.isStereo) && !this.hasTouch;
          this.mousePointer.showPointer = !this.hasMotionControllers && !this.VR.isStereo;

          let heading = 0,
            pitch = 0,
            strafe = 0,
            drive = 0;
          for (let i = 0; i < this.managers.length; ++i) {
            const mgr = this.managers[i];
            if(mgr.enabled){
              if(mgr.name !== "Mouse"){
                heading += mgr.getValue("heading");
              }
              pitch += mgr.getValue("pitch");
              strafe += mgr.getValue("strafe");
              drive += mgr.getValue("drive");
            }
          }

          if(this.hasMouse) {
            let mouseHeading = null;
            if (this.VR.hasOrientation) {
              mouseHeading = this.mousePointer.rotation.y;
              const newMouseHeading = WEDGE * Math.floor((mouseHeading / WEDGE) + 0.5);
              let offset = this.Mouse.commands.U.offset;
              if(newMouseHeading !== 0){
                offset += 1 - this.Mouse.getValue("U");
                this.Mouse.setOffset(offset);
              }
              mouseHeading = newMouseHeading + offset * 2;
            }
            else{
              mouseHeading = this.Mouse.getValue("heading");
            }
            heading += mouseHeading;
          }

          if (this.VR.hasOrientation) {
            pitch = 0;
          }

          // move stage according to heading and thrust
          EULER_TEMP.set(pitch, heading, 0, "YXZ");
          this.stage.quaternion.setFromEuler(EULER_TEMP);

          // update the stage's velocity
          this.velocity.set(strafe, 0, drive);

          QUAT_TEMP.copy(this.head.quaternion);
          EULER_TEMP.setFromQuaternion(QUAT_TEMP);
          EULER_TEMP.x = 0;
          EULER_TEMP.z = 0;
          QUAT_TEMP.setFromEuler(EULER_TEMP);

          this.moveStage(DISPLACEMENT
            .copy(this.velocity)
            .multiplyScalar(dt)
            .applyQuaternion(QUAT_TEMP)
            .add(this.head.position));

          this.stage.position.y = this.ground && this.ground.getHeightAt(this.stage.position) || 0;
          this.stage.position.y += this.options.avatarHeight;
          for (let i = 0; i < this.motionDevices.length; ++i) {
            this.motionDevices[i].posePosition.y -= this.options.avatarHeight;
          }

          // update the motionDevices
          this.stage.updateMatrix();
          this.matrix.multiplyMatrices(this.stage.matrix, this.VR.stage.matrix);
          for (let i = 0; i < this.motionDevices.length; ++i) {
            this.motionDevices[i].updateStage(this.matrix);
          }

          for (let i = 0; i < this.pointers.length; ++i) {
            this.pointers[i].update();
          }

          // record the position and orientation of the user
          this.newState = [];
          this.head.updateMatrix();
          this.stage.rotation.x = 0;
          this.stage.rotation.z = 0;
          this.stage.quaternion.setFromEuler(this.stage.rotation);
          this.stage.updateMatrix();
          this.head.position.toArray(this.newState, 0);
          this.head.quaternion.toArray(this.newState, 3);

          if(frame === 0) {
            updateAll();
            let userActionHandlers = null;
            for (let i = 0; i < this.pointers.length; ++i) {
              userActionHandlers = this.pointers[i].resolvePicking(this.scene);
            }
            for (let i = 0; i < this.managers.length; ++i) {
              this.managers[i].userActionHandlers = userActionHandlers;
            }

            moveUI();
          }

          /*
          pliny.event({
            parent: "Primrose.Environment",
            name: "update",
            description: "Fires after every animation update."
          });
          */
          try {
            this.emit("update");
          }
          catch(exp){
            // don't let user script kill the runtime
            console.error("User update errored", exp);
          }
        }

        for(let i = 0; i < this.plugins.length; ++i) {
          this.plugins[i].postUpdate(this, dt);
        }
      }
    };

    /*
    pliny.property({
      parent: "Primrose.Environment",
      name: "turns",
      type: "Util.Angle",
      description: "A slewing angle that loosely follows the user around."
    });
    */
    this.turns = new Angle(0);
    const followEuler = new Euler(),
      maxX = -Math.PI / 4,
      maxY = Math.PI / 6;

    const moveUI = (dt) => {
      var y = this.vicinity.position.y,
        p = this.options.vicinityFollowRate,
        q = 1 - p;
      this.vicinity.position.lerp(this.head.position, p);
      this.vicinity.position.y = y;

      followEuler.setFromQuaternion(this.head.quaternion);
      this.turns.radians = followEuler.y;
      followEuler.set(maxX, this.turns.radians, 0, "YXZ");
      this.ui.quaternion.setFromEuler(followEuler)
      this.ui.position.y = this.ui.position.y * q + this.head.position.y * p;
    };

    var animate = (t) => {
      var dt = t - lt,
        i, j;
      lt = t;
      update(dt);
      render();
    };

    var render = () => {
      this.camera.position.set(0, 0, 0);
      this.camera.quaternion.set(0, 0, 0, 1);
      this.renderer.clear(true, true, true);

      var trans = this.VR.getTransforms(
        this.options.nearPlane,
        this.options.nearPlane + this.options.drawDistance);
      for (var i = 0; trans && i < trans.length; ++i) {
        eyeBlankAll(i);

        var st = trans[i],
          v = st.viewport;

        this.renderer.setViewport(
          v.left * resolutionScale,
          0,
          v.width * resolutionScale,
          v.height * resolutionScale);

        this.camera.projectionMatrix.fromArray(st.projection);
        if (this.mousePointer.unproject) {
          this.mousePointer.unproject.getInverse(this.camera.projectionMatrix);
        }
        this.camera.matrixWorld.fromArray(st.view);
        this.renderer.render(this.scene, this.camera);
      }
      this.VR.submitFrame();
    };

    this._modifyScreen = () => {
      var near = this.options.nearPlane,
        far = near + this.options.drawDistance,
        p = this.VR && this.VR.getTransforms(near, far);

      if (p) {
        var canvasWidth = 0,
          canvasHeight = 0;

        for (var i = 0; i < p.length; ++i) {
          canvasWidth += p[i].viewport.width;
          canvasHeight = Math.max(canvasHeight, p[i].viewport.height);
        }

        this.mousePointer.setSize(canvasWidth, canvasHeight);

        const styleWidth = canvasWidth / devicePixelRatio,
          styleHeight = canvasHeight / devicePixelRatio;
        canvasWidth = Math.floor(canvasWidth * resolutionScale);
        canvasHeight = Math.floor(canvasHeight * resolutionScale);

        this.renderer.domElement.width = canvasWidth;
        this.renderer.domElement.height = canvasHeight;
        this.renderer.domElement.style.width = styleWidth + "px";
        this.renderer.domElement.style.height = styleHeight + "px";
        if (!this.VR.currentDevice.isAnimating) {
          render();
        }
      }
    };

    //
    // Initialize local variables
    //

    var lt = 0,
      currentHeading = 0,
      qPitch = new Quaternion(),
      vEye = new Vector3(),
      vBody = new Vector3(),
      resolutionScale = 1;

    /*
    pliny.property({
      parent: "Primrose.Environment",
      name: "avatar",
      type: "Object",
      description: "An object factory for the 3D model representing users."
    });
    */
    this.avatar = null;

    function setColor(model, color) {
      return model.children[0].material.color.set(color);
    }

    function complementColor(color) {
      var rgb = color.clone();
      var hsl = rgb.getHSL();
      hsl.h = hsl.h + 0.5;
      hsl.l = 1 - hsl.l;
      while (hsl.h > 1) hsl.h -= 1;
      rgb.setHSL(hsl.h, hsl.s, hsl.l);
      return rgb;
    }

    //
    // Initialize public properties
    //

    /*
    pliny.property({
      parent: "Primrose.Environment",
      name: "speech",
      type: "Primrose.Audio.Speech",
      description: "A text-2-speech system."
    });
    */
    this.speech = null;

    /*
    pliny.property({
      parent: "Primrose.Environment",
      name: "audio",
      type: "Primrose.Audio.Audio3D",
      description: "An audio graph that keeps track of 3D information."
    });
    */
    this.audio = null;

    /*
    pliny.property({
      parent: "Primrose.Environment",
      name: "music",
      type: "Primrose.Audio.Music",
      description: "A primitive sort of synthesizer for making simple music."
    });
    */
    this.music = null;

    /*
    pliny.property({
      parent: "Primrose.Environment",
      name: "currentControl",
      type: "Primrose.Control.Entity",
      description: "The currently selected control, by a user-click or some other function."
    });
    */
    this.currentControl = null;


    /*
    pliny.method({
      parent: "Primrose.Environment",
      name: "fadeOut",
      returns: "Promise",
      description: "Causes the fully rendered view fade out to the color provided `options.backgroundColor`"
    });
    */
    this.fadeOut = () => this.fader && this.fader.fadeOut();

    /*
    pliny.method({
      parent: "Primrose.Environment",
      name: "fadeIn",
      returns: "Promise",
      description: "Causes the faded out cube to disappear."
    });
    */
    this.fadeIn = () => this.fader && this.fader.fadeIn();

    /*
    pliny.property({
      parent: "Primrose.Environment",
      name: "teleportAvailable",
      type: "Boolean",
      description: "Returns true when the system is not currently fading out or in.`"
    });
    */
    this.teleportAvailable = true;

    /*
    pliny.method({
      parent: "Primrose.Environment",
      name: "transition",
      returns: "Promise",
      description: "Perform an action in between a fade-out and a fade-in. Useful for hiding actions that might cause the view update to freeze, so the user doesn't get sick.",
      parameters: [{
        name: "thunk",
        type: "Function",
        description: "A callback function, to be executed between the fade-out and fade-in effects."
      }]
    });
    */
    this.transition = (thunk, check, immediate) => this.fader && this.fader.transition(thunk, check, immediate);


    /*
    pliny.method({
      parent: "Primrose.Environment",
      name: "teleport",
      returns: "Promise",
      description: "Move the user to a position, using the fade-out/fade-in transition effect.",
      parameters: [{
        name: "pos",
        type: "THREE.Vector3",
        description: "The point at which to move the user."
      }, {
        name: "immediate",
        type: "Boolean",
        optional: true,
        default: false,
        description: "If true, skips the transition effect."
      }]
    });
    */
    this.teleport = (pos, immediate) => this.transition(
      () => this.moveStage(pos),
      () => this.teleportAvailable && TELEPORT_DISPLACEMENT.copy(pos)
        .sub(this.head.position)
        .length() > 0.2,
      immediate);

    const delesectControl = () => {
      if(this.currentControl) {
        this.currentControl.removeEventListener("blur", delesectControl);
        this.Keyboard.enabled = true;
        this.Mouse.enable("pitch", !this.VR.isPresenting);
        this.Mouse.enable("heading", !this.VR.isPresenting);
        this.currentControl.blur();
        this.currentControl = null;
      }
    };

    /*
    pliny.method({
      parent: "Primrose.Environment",
      name: "consumeEvent",
      description: "Handles pointer interactions and differentiates between teleportation and selecting controls on the screen.",
      parameters: [{
        name: "evt",
        type: "Event",
        description: "A pointer click event that triggered."
      }]
    });
    */
    this.consumeEvent = (evt) => {
      const obj = evt.hit && evt.hit.object,
        cancel = evt.type === "exit" || evt.cmdName === "NORMAL_ESCAPE";

      if(evt.type === "select" || cancel) {

        if(obj !== this.currentControl || cancel){

          delesectControl();

          if(!cancel && obj.isSurface){
            this.currentControl = obj;
            this.currentControl.focus();
            this.currentControl.addEventListener("blur", delesectControl);
            if(this.currentControl.lockMovement) {
              this.Keyboard.enabled = false;
              this.Mouse.enable("pitch", this.VR.isPresenting);
              this.Mouse.enable("heading", this.VR.isPresenting);
            }
          }
        }
      }

      if(obj) {
        obj.dispatchEvent(evt);
      }
      else if(this.currentControl){
        this.currentControl.dispatchEvent(evt);
      }

      this.dispatchEvent(evt);
    };


    /*
    pliny.property({
      parent: "Primrose.Environment",
      name: "scene",
      type: "THREE.Scene",
      description: "The 3D scene that gets displayed to the user."
    });
    */
    this.options.scene = this.scene = this.options.scene || new Scene();

    /*
    pliny.property({
      parent: "Primrose.Environment",
      name: "camera",
      type: "THREE.PerspectiveCamera",
      description: "The camera used to render the view."
    });
    */
    this.camera = new PerspectiveCamera(75, 1, this.options.nearPlane, this.options.nearPlane + this.options.drawDistance);

    /*
    pliny.property({
      parent: "Primrose.Environment",
      name: "sky",
      type: "THREE.Object3D",
      description: "If a `skyTexture` option is provided, it will be a texture cube or photosphere. If no `skyTexture` option is provided, there will only be a THREE.Object3D, to create an anchor point on which implementing scripts can add objects that follow the user's position."
    });
    */
    this.sky = null;


    /*
    pliny.property({
      parent: "Primrose.Environment",
      name: "ground",
      type: "THREE.Object3D",
      description: "If a `groundTexture` option is provided, it will be a flat plane extending to infinity. As the user moves, the ground will shift under them by whole texture repeats, making the ground look infinite."
    });
    */
    this.ground = null;

    this.teleporter = null;

    this.fader = null;


    /*
    pliny.property({
      parent: "Primrose.Environment",
      name: "ui",
      type: "THREE.Object3D",
      description: "An anchor point on which objects can be added that follows the user around in both position and orientation. The orientation lags following the user, so if the UI is ever in the way, the user can turn slightly and it won't follow them."
    });
    */
    this.vicinity = hub().named("Vicinity").addTo(this.scene);
    this.ui = hub().named("UI").addTo(this.vicinity);

    this.addAvatar = (user) => {
      console.log(user);
      this.scene.add(user.stage);
      this.scene.add(user.head);
    };

    this.removeAvatar = (user) => {
      this.scene.remove(user.stage);
      this.scene.remove(user.head);
    };

    let allowRestart = true;

    /*
    pliny.method({
      parent: "Primrose.Environment",
      name: "start",
      returns: "Promise",
      description: "Restart animation after it has been stopped."
    });
    */
    this.start = () => {
      if(allowRestart) {
        this.ready.then(() => {
          this.VR.currentDevice.startAnimation(animate);
          lt = performance.now() * MILLISECONDS_TO_SECONDS;
          this.renderer.domElement.style.cursor = "none";
          let promise = Promise.resolve();
          for(let i = 0; i < this.plugins.length; ++i) {
            const plugin = this.plugins[i];
            promise = promise.then(() =>
              plugin.start());
          }
          return promise;
        });
      }
    };


    /*
    pliny.method({
      parent: "Primrose.Environment",
      name: "stop",
      description: "Pause animation.",
      parameters: [ {
        name: "evt",
        type: "Event",
        optional: true,
        default: null,
        description: "The event that triggered this function."
      }, {
        name: "restartAllowed",
        type: "Boolean",
        optional: true,
        default: false,
        description: "Whether or not calling `start()` again is allowed, or if this is a permanent stop."
      } ]
    });
    */
    this.stop = (evt, restartAllowed) => {
      if(allowRestart) {
        allowRestart = restartAllowed;

        this.plugins.forEach((plugin) =>
          plugin.stop());

        this.VR.displays.forEach((display) =>
          display.stopAnimation());

        this.renderer.domElement.style.cursor = "";
        console.log("stopped");
      }
    };

    this.pause = (evt) => this.stop(evt, true);

    window.addEventListener("resize", this._modifyScreen, false);
    if(!options.disableAutoPause) {
      window.addEventListener("focus", this.start, false);
      window.addEventListener("blur", this.pause, false);
    }
    window.addEventListener("stop", this.stop, false);
    document.addEventListener("amazonPlatformReady", () => {
      document.addEventListener("pause", this.pause, false);
      document.addEventListener("resume", this.start, false);
    }, false);

    /*
    pliny.property({
      parent: "Primrose.Environment",
      name: "renderer",
      type: "THREE.WebGLRenderer",
      description: "The Three.js renderer being used to draw the scene."
    });
    */


    const installPlugins = (toProcess) => {
      if(toProcess.length > 0) {

        let task = null;

        const plugin = toProcess.shift();

        if(plugin.isBasePlugin) {

          const missingRequirements = plugin.requirementsMet(this).join(", ");

          if(missingRequirements.length === 0) {
            task = plugin.install(this)
              .then((newPlugins) =>
                newPlugins.concat(toProcess))
              .catch((err) => {
                console.error(`Error while installing ${plugin.name}: ${err && err.message || err}`);
                return toProcess;
              });
          }
          else if(plugin.retry > 0) {
            console.warn(`Couldn't install ${plugin.name}. Missing requirements: [${missingRequirements}]. Will retry later.`);
            --plugin.retry;
            task = Promise.resolve(toProcess.concat([plugin]));
          }
          else {
            console.error(`Couldn't install ${plugin.name}. Missing requirements: [${missingRequirements}]. Will not retry.`);
            task = Promise.resolve(toProcess);
          }
        }

        if(!task) {
          task = Promise.resolve(toProcess);
        }

        return task.then(installPlugins);
      }
    };


    this.ready = documentReady
      .then(() => {
        if (this.options.renderer) {
          this.renderer = this.options.renderer;
        }
        else {
          this.renderer = new WebGLRenderer({
            canvas: cascadeElement(this.options.canvasElement, "canvas", HTMLCanvasElement),
            context: this.options.context,
            antialias: this.options.antialias,
            alpha: true,
            logarithmicDepthBuffer: false
          });
          this.renderer.autoClear = false;
          this.renderer.sortObjects = true;
          this.renderer.setClearColor(this.options.backgroundColor);
          if (!this.renderer.domElement.parentElement) {
            document.body.appendChild(this.renderer.domElement);
          }
        }

        this.options.fullScreenElement = cascadeElement(this.options.fullScreenElement) || this.renderer.domElement.parentElement;
        let maxTabIndex = 0;
        const elementsWithTabIndex = document.querySelectorAll("[tabIndex]");
        for(let i = 0; i < elementsWithTabIndex.length; ++i){
          maxTabIndex = Math.max(maxTabIndex, elementsWithTabIndex[i].tabIndex);
        }

        this.renderer.domElement.tabIndex = maxTabIndex + 1;
        this.renderer.domElement.addEventListener('webglcontextlost', this.pause, false);
        this.renderer.domElement.addEventListener('webglcontextrestored', this.start, false);

        this.managers = [];
        this.newState = [];
        this.pointers = [];
        this.motionDevices = [];
        this.velocity = new Vector3();
        this.matrix = new Matrix4();

        if(!this.options.disableKeyboard) {
          this.addInputManager(new Keyboard(this, {
            strafeLeft: {
              buttons: [
                -Keys.A,
                -Keys.LEFTARROW
              ]
            },
            strafeRight: {
              buttons: [
                Keys.D,
                Keys.RIGHTARROW
              ]
            },
            strafe: {
              commands: ["strafeLeft", "strafeRight"]
            },
            driveForward: {
              buttons: [
                -Keys.W,
                -Keys.UPARROW
              ]
            },
            driveBack: {
              buttons: [
                Keys.S,
                Keys.DOWNARROW
              ]
            },
            drive: {
              commands: ["driveForward", "driveBack"]
            },
            select: {
              buttons: [Keys.ENTER]
            },
            dSelect: {
              buttons: [Keys.ENTER],
              delta: true
            },
            zero: {
              buttons: [Keys.Z],
              metaKeys: [
                -Keys.CTRL,
                -Keys.ALT,
                -Keys.SHIFT,
                -Keys.META
              ],
              commandUp: this.emit.bind(this, "zero")
            }
          }));

          this.Keyboard.operatingSystem = this.options.os;
          this.Keyboard.codePage = this.options.language;
        }

        this.addInputManager(new Touch(this.renderer.domElement, {
          U: { axes: ["X0"], min: 0, max: 2, offset: 0 },
          V: { axes: ["Y0"], min: 0, max: 2 },
          buttons: {
            axes: ["FINGERS"]
          },
          dButtons: {
            axes: ["FINGERS"],
            delta: true
          },
          heading: {
            axes: ["DX0"],
            integrate: true
          },
          pitch: {
            axes: ["DY0"],
            integrate: true,
            min: -Math.PI * 0.5,
            max: Math.PI * 0.5
          }
        }));


        this.addInputManager(new Mouse(this.options.fullScreenElement, {
          U: { axes: ["X"], min: 0, max: 2, offset: 0 },
          V: { axes: ["Y"], min: 0, max: 2 },
          buttons: {
            axes: ["BUTTONS"]
          },
          dButtons: {
            axes: ["BUTTONS"],
            delta: true
          },
          _dx: {
            axes: ["X"],
            delta: true,
            scale: 0.25
          },
          dx: {
            buttons: [0],
            commands: ["_dx"]
          },
          heading: {
            commands: ["dx"],
            integrate: true
          },
          _dy: {
            axes: ["Y"],
            delta: true,
            scale: 0.25
          },
          dy: {
            buttons: [0],
            commands: ["_dy"]
          },
          pitch: {
            commands: ["dy"],
            integrate: true,
            min: -Math.PI * 0.5,
            max: Math.PI * 0.5
          }
        }));

        // toggle back and forth between touch and mouse
        this.Touch.addEventListener("activate", (evt) => this.Mouse.inPhysicalUse = false);
        this.Mouse.addEventListener("activate", (evt) => this.Touch.inPhysicalUse = false);

        this.addInputManager(new VR(this.options));

        this.motionDevices.push(this.VR);

        this.stage = hub();

        this.head = new Pointer("GazePointer", 0xffff00, 0x0000ff, 0.8, [
          this.VR
        ], [
          this.Mouse,
          this.Touch,
          this.Keyboard
        ], this.options)
          .addTo(this.scene);

        this.head.route(Pointer.EVENTS, this.consumeEvent.bind(this));

        this.head.rotation.order = "YXZ";
        this.head.useGaze = this.options.useGaze;
        this.pointers.push(this.head);

        this.mousePointer = new Pointer("MousePointer", 0xff0000, 0x00ff00, 1, [
          this.Mouse,
          this.Touch
        ], null, this.options);
        this.mousePointer.route(Pointer.EVENTS, this.consumeEvent.bind(this));
        this.mousePointer.unproject = new Matrix4();
        this.pointers.push(this.mousePointer);
        this.head.add(this.mousePointer);

        /*
        pliny.event({
          parent: "Primrose.Environment",
          name: "select",
          description: "Fired when an object has been selected, either by a physical cursor or a gaze-based cursor. You will typically want to use this instead of pointerend or gazecomplete."
        });
        */

        /*
        pliny.event({
          parent: "Primrose.Environment",
          name: "pointerstart",
          description: "Fired when mouse, gamepad, or touch-based pointers have their trigger buttons depressed."
        });
        */

        /*
        pliny.event({
          parent: "Primrose.Environment",
          name: "pointerend",
          description: "Fired when mouse, gamepad, or touch-based pointers have their trigger buttons released."
        });
        */

        /*
        pliny.event({
          parent: "Primrose.Environment",
          name: "pointermove",
          description: "Fired when mouse, gamepad, or touch-based pointers are moved away from where they were last frame."
        });
        */

        /*
        pliny.event({
          parent: "Primrose.Environment",
          name: "gazestart",
          description: "Fired when a gaze-based cursor starts spinning on a selectable object."
        });
        */

        /*
        pliny.event({
          parent: "Primrose.Environment",
          name: "gazemove",
          description: "Fired when a gaze-based cursor moves across an object that it is attempting to select."
        });
        */

        /*
        pliny.event({
          parent: "Primrose.Environment",
          name: "gazecomplete",
          description: "Fired when a gaze-based cursor finishes spinning on a selectable object."
        });
        */

        /*
        pliny.event({
          parent: "Primrose.Environment",
          name: "gazecancel",
          description: "Fired when a gaze-based cursor is moved off of the object it is attempting to select before it can finish spinning."
        });
        */

        /*
        pliny.event({
          parent: "Primrose.Environment",
          name: "exit",
          description: "Fired when a pointer leaves an object."
        });
        */

        /*
        pliny.event({
          parent: "Primrose.Environment",
          name: "enter",
          description: "Fired when a pointer hovers over an object."
        });
        */


        if(!this.options.disableKeyboard) {
          const keyDown =  (evt) => {
              if (this.VR.isPresenting) {
                if (evt.keyCode === Keys.ESCAPE && !this.VR.isPolyfilled) {
                  this.cancelVR();
                }
              }

              this.Keyboard.consumeEvent(evt);
              this.consumeEvent(evt);
            },

            keyUp = (evt) => {
              this.Keyboard.consumeEvent(evt);
              this.consumeEvent(evt);
            },

            readWheel = (evt) => {
              if (this.currentControl) {
                if (this.currentControl.readWheel) {
                  this.currentControl.readWheel(evt);
                }
                else {
                  console.warn("Couldn't find readWheel on %o", this.currentControl);
                }
              }
            };

          window.addEventListener("keydown", keyDown, false);

          window.addEventListener("keyup", keyUp, false);

          window.addEventListener("wheel", readWheel, false);
        }

        this.head.add(this.camera);

        return Promise.all(this.managers
          .map((mgr) => mgr.ready)
          .filter(identity));
      })
      .then(() => installPlugins(this.plugins.slice()))
      .then(() => {
        this.VR.displays
          .filter((display) => "DOMElement" in display)
          .forEach((display) => display.DOMElement = this.renderer.domElement);

        this.VR.connect(0);
        this.options.progress.hide();

        /*
        pliny.event({
          parent: "Primrose.Environment",
          name: "ready",
          description: "Fires after the initial assets have been downloaded and the scene initialized, just before animation starts."
        });
        */
        this.emit("ready");
      });

    /*
    pliny.property({
      parent: "Primrose.Environment",
      name: "quality",
      type: "Primrose.Constants.Quality",
      description: "The current render quality."
    });
    */
    Object.defineProperties(this, {
      quality: {
        get: () => this.options.quality,
        set: (v) => {
          if (0 <= v && v < PIXEL_SCALES.length) {
            this.options.quality = v;
            resolutionScale = PIXEL_SCALES[v];
          }
          this.ready.then(this._modifyScreen);
        }
      }
    });

    this.quality = this.options.quality;

    if (window.alert.toString().indexOf("native code") > -1) {
      // overwrite the native alert functions so they can't be called while in
      // full screen VR mode.

      var rerouteDialog = (oldFunction, newFunction) => {
        if (!newFunction) {
          newFunction = function () {};
        }
        return (function () {
          if (this.VR && this.VR.isPresenting) {
            newFunction();
          }
          else {
            oldFunction.apply(window, arguments);
          }
        }).bind(this);
      };

      window.alert = rerouteDialog(window.alert);
      window.confirm = rerouteDialog(window.confirm);
      window.prompt = rerouteDialog(window.prompt);
    }

    this.start();
  }


  /*
  pliny.property({
    parent: "Primrose.Environment",
    name: "lockMovement",
    type: "Boolean",
    description: "True if the user is focused on a text box control. If the user is focused on a text box control, keyboard commands should not move their position."
  });
  */
  get lockMovement(){
    return this.currentControl && this.currentControl.lockMovement;
  }


  /*
  pliny.method({
    parent: "Primrose.Environment",
    name: "connect",
    description: "Connect to a server at a WebSocket using a specific userName. NOTE: this does not handle authentication or authorization. You must handle those tasks yourself. This only binds an authenticated WebSocket connection to the framework so the framework may use it to transmit user state.",
    parameters: [{
      name: "socket",
      type: "WebSocket",
      description: "The socket connecting us to the server."
    }, {
      name: "userName",
      type: "String",
      description: "The name of the user being connected."
    }]
  });
  */
  connect(socket, userName) {
    return this.network && this.network.connect(socket, userName);
  }

  /*
  pliny.method({
    parent: "Primrose.Environment",
    name: "disconnect",
    description: "Disconnect from the server."
  });
  */
  disconnect() {
    return this.network && this.network.disconnect();
  }


  /*
  pliny.property({
    parent: "Primrose.Environment",
    name: "displays",
    type: "Array of BaseVRDisplay",
    description: "The VRDisplays available on the system."
  });
  */
  get displays() {
    return this.VR.displays;
  }

  get currentTime() {
    return this.audio && this.audio.context && this.audio.context.currentTime;
  }

  addInputManager(mgr) {
    for (let i = this.managers.length - 1; i >= 0; --i) {
      if (this.managers[i].name === mgr.name) {
        this.managers.splice(i, 1);
      }
    }
    this.managers.push(mgr);
    this[mgr.name] = mgr;
  }

  removeInputManager(id) {
    const mgr = this[id],
      mgrIdx = this.managers.indexOf(mgr);
    if (mgrIdx > -1) {
      this.managers.splice(mgrIdx, 1);
      delete this[id];
    }
  }

  moveStage(position) {
    DISPLACEMENT.copy(position)
      .sub(this.head.position);

    this.stage.position.add(DISPLACEMENT);
  }

  cancelVR() {
    this.VR.cancel();
    this.Touch.setOffset("U", 0);
    this.Mouse.setOffset("U", 0);
  }

  get hasMotionControllers() {
    return !!(this.Vive_0 && this.Vive_0.enabled && this.Vive_0.inPhysicalUse ||
      this.Vive_1 && this.Vive_1.enabled && this.Vive_1.inPhysicalUse);
  }

  get hasGamepad() {
    return !!(this.Gamepad_0 && this.Gamepad_0.enabled && this.Gamepad_0.inPhysicalUse);
  }

  get hasMouse() {
    return !!(this.Mouse && this.Mouse.enabled && this.Mouse.inPhysicalUse);
  }

  get hasTouch() {
    return !!(this.Touch && this.Touch.enabled && this.Touch.inPhysicalUse);
  }

  setAudioFromUser(userName, audioElement){

    /*
    pliny.method({
      parent: "Primrose.Environment",
      name: "setAudioFromUser",
      description: "When using a 3D-party voice chat provider, this method associates the `HTMLVideoElement` or `HTMLAudioElement` created by the chat provider with the remote user, so that their audio may be spatialized with their position.",
      parameters: [{
        name: "userName",
        type: "String",
        description: "The name of the user to which to add the audio."
      }, {
        name: "audioElement",
        type: "HTMLAudioElement or HTMLVideoElement",
        description: "The DOM element that represents the user's audio."
      }]
    });
    */

    this.audioQueue.push([userName, audioElement]);
    if(this.network){
      while(this.audioQueue.length > 0){
        this.network.setAudioFromUser.apply(this.network, this.audioQueue.shift());
      }
    }
  }
}

/*
pliny.record({
  parent: "Primrose.Environment",
  name: "optionsHash",
  description: "Settings to change how the environment looks and behaves.",
  parameters: [{
    name: "antialias",
    type: "Boolean",
    optional: true,
    default: true,
    description: "Enable or disable anti-aliasing"
  }, {
    name: "quality",
    type: "Primrose.Constants.Quality",
    optional: true,
    default: "Primrose.Constants.Quality.MAXIMUM",
    description: "The quality level at which to start rendering."
  }, {
    name: "fullScreenButtonContainer",
    type: "String",
    optional: true,
    default: null,
    description: "A DOM query selector that, if provided, will have buttons added to it for each of the fullscreen modes."
  }, {
    name: "useGaze",
    type: "Boolean",
    optional: true,
    description: "Whether or not to used timed ring cursors. Defaults to true if the current system is a mobile device. Defaults to false if it's a desktop system."
  }, {
    name: "avatarHeight",
    type: "Number",
    optional: true,
    default: 1.65,
    description: "The default height of the user's avatar, if the VR system doesn't provide a height."
  }, {
    name: "walkSpeed",
    type: "Number",
    optional: true,
    default: 2,
    description: "The number of meters per second at which the user runs."
  }, {
    name: "disableKeyboard",
    type: "Boolean",
    optional: true,
    default: false,
    description: "Set to true to disable keyboard-based input."
  }, {
    name: "plugins",
    type: "Array",
    optional: true,
    default: null,
    description: "An array of `Primrose.Plugin.BasePlugin`s that will modify the Environment. By carving this functionality into Plugins, it allows the implementing developer to keep their bundle size small by avoiding features they don't care to use."
  }, {
    name: "progress",
    type: "Object",
    optional: true,
    default: null,
    description: "A hash object with callback functions for recording model download progress. Callbacks are named `thunk`, `hide`, and `resize`."
  }, {
    name: "fadeRate",
    type: "Number",
    optional: true,
    default: 5,
    description: "The change in opacity per second when fading between scenes."
  }, {
    name: "vicinityFollowRate",
    type: "Number",
    optional: true,
    default: 0.02,
    description: "The rate at which the UI shell catches up with the user's movement."
  }, {
    name: "gazeLength",
    type: "Number",
    optional: true,
    default: 1.5,
    description: "The amount of time in seconds to require gazes on objects before triggering the gaze event."
  }, {
    name: "disableAutoPause",
    type: "Boolean",
    description: "By default, the rendering will be paused when the browser window loses focus.",
    optional: true,
    default: false
  }, {
    name: "disableMirroring",
    type: "Boolean",
    optional: true,
    default: false,
    description: "By default, what we see in the VR view will get mirrored to a regular view on the primary screen. Set to true to improve performance."
  }, {
    name: "disableMotion",
    type: "Boolean",
    optional: true,
    default: false,
    description: "By default, mobile devices have a motion sensor that can be used to update the view. Set to true to disable motion tracking."
  }, {
    name: "disableDefaultLighting",
    type: "Boolean",
    optional: true,
    default: false,
    description: "By default, a single light is added to the scene,"
  }, {
    name: "backgroundColor",
    type: "Number",
    optional: true,
    default: 0xafbfff,
    description: "The color that WebGL clears the background with before drawing."
  }, {
    name: "nearPlane",
    type: "Number",
    optional: true,
    default: 0.01,
    description: "The near plane of the camera."
  }, {
    name: "drawDistance",
    type: "Number",
    optional: true,
    default: 100,
    description: "The distance from the near plane to the far plane of the camera."
  }, {
    name: "defaultFOV",
    type: "Number",
    optional: true,
    default: 75,
    description: "The field of view to use in non-VR settings."
  }, {
    name: "canvasElement",
    type: "HTMLCanvasElement",
    optional: true,
    default: "frontBuffer",
    description: "HTML5 canvas element to which to render, if one had already been created."
  }, {
    name: "renderer",
    type: "THREE.WebGLRenderer",
    optional: true,
    description: "Three.js renderer, if one had already been created."
  }, {
    name: "context",
    type: "WebGLRenderingContext",
    optional: true,
    description: "A WebGL context to use, if one had already been created."
  }, {
    name: "scene",
    type: "THREE.Scene",
    optional: true,
    description: "Three.js scene, if one had already been created."
  }, {
    name: "nonstandardNeckLength",
    type: "Number",
    optional: true,
    default: 0.15,
    description: "When creating a neck model, this is how high the neck runs. This is an experimental feature for setting the height of a user's \"neck\" on orientation-only systems (such as Google Cardboard and Samsung Gear VR) to create a more realistic feel."
  }, {
    name: "nonstandardNeckDepth",
    type: "Number",
    optional: true,
    default: 0.075,
    description: "When creating a neck model, this is the distance from the center meridian of the neck to the eyes."
  }, {
    name: "showHeadPointer",
    type: "Boolean",
    optional: true,
    default: true,
    description: "Whether or not to show a pointer tracking the gaze direction."
  }, {
    name: "nonstandardIPD",
    type: "Number",
    optional: true,
    description: "When creating a neck model, this is the how far apart to set the eyes. I highly suggest you don't go down the road that requires setting this. I will not help you understand what it does, because I would rather you just not use it."
  }]
});
*/
Environment.DEFAULTS = {
  antialias: true,
  quality: Quality.MAXIMUM,
  fullScreenButtonContainer: null,
  avatarHeight: 1.65,
  walkSpeed: 2,
  disableKeyboard: false,
  plugins: [],
  progress: window.Preloader || {
    thunk: function() {},
    hide: function() {},
    resize: function() {}
  },
  fadeRate: 5,
  fullScreenElement: document.body,
  vicinityFollowRate: 0.02,
  gazeLength: 1.5,
  disableAutoPause: false,
  disableMirroring: false,
  disableMotion: false,
  disableDefaultLighting: false,
  backgroundColor: 0xafbfff,
  skyTexture: null,
  nearPlane: 0.01,
  drawDistance: 100,
  defaultFOV: StandardMonitorVRDisplay.DEFAULT_FOV,
  canvasElement: "frontBuffer",
  renderer: null,
  context: null,
  plugins: [],
  scene: null,
  // This is an experimental feature for setting the height of a user's "neck" on orientation-only systems (such as Google Cardboard and Samsung Gear VR) to create a more realistic feel.
  nonstandardNeckLength: null,
  nonstandardNeckDepth: null,
  showHeadPointer: true,
  // WARNING: I highly suggest you don't go down the road that requires the following settings this. I will not help you understand what they do, because I would rather you just not use them.
  nonstandardIPD: null,
  disableAdvertising: false
};