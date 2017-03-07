pliny.class({
  parent: "Primrose.Input",
  name: "PoseInputProcessor",
  baseClass: "Primrose.Input.InputProcessor",
  description: "| [under construction]"
});

const DEFAULT_POSE = {
    position: [0, 0, 0],
    orientation: [0, 0, 0, 1]
  },
  EMPTY_SCALE = new Vector3();

import { Vector3, Quaternion, Matrix4 } from "three";
import InputProcessor from "./InputProcessor";
export default class PoseInputProcessor extends InputProcessor {
  constructor(name, commands, axisNames) {
    super(name, commands, axisNames);

    this.currentDevice = null;
    this.lastPose = null;
    this.posePosition = new Vector3();
    this.poseQuaternion = new Quaternion();
    this.position = new Vector3();
    this.quaternion = new Quaternion();
    this.matrix = new Matrix4();
  }

  update(dt) {
    super.update(dt);

    if (this.currentDevice) {
      const frame = this.currentDevice && this.currentDevice.frameData || this.frameData,
        pose = frame && frame.pose || this.lastPose || DEFAULT_POSE;
      this.lastPose = pose;
      this.inPhysicalUse = this.hasOrientation || this.inPhysicalUse;

      const orient = pose && pose.orientation;
      const pos = pose && pose.position;

      if (orient) {
        this.poseQuaternion.fromArray(orient);
      }
      else {
        this.poseQuaternion.set(0, 0, 0, 1);
      }

      if (pos) {
        this.posePosition.fromArray(pos);
      }
      else {
        this.posePosition.set(0, 0, 0);
      }
    }
  }

  updateStage(stageMatrix) {
    this.matrix.makeRotationFromQuaternion(this.poseQuaternion);
    this.matrix.setPosition(this.posePosition);
    this.matrix.multiplyMatrices(stageMatrix, this.matrix);
    this.matrix.decompose(this.position, this.quaternion, EMPTY_SCALE);
  }
};
