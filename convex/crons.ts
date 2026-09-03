import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Every 1 minute, check if schedule needs rotation
crons.interval(
  "rotateSchedule",
  { minutes: 1 },
  internal.channel.rotateSchedule,
);

export default crons;
