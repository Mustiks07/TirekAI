// npm run demo:reset — returns the local database to the state saved by npm run demo:prepare.
import { restoreBaseline } from "./state";

restoreBaseline()
  .then(() =>
    console.log(
      "Demo baseline restored. Start the app with npm run dev or npm run preview.",
    ),
  )
  .catch((e) => {
    console.error(
      "DEMO_RESET_FAILED",
      e instanceof Error ? e.message : "Error",
    );
    process.exitCode = 1;
  });
