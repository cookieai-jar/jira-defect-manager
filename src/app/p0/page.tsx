import { redirect } from "next/navigation";

// White-glove customers moved into Settings; keep the old path working.
export default function P0Page() {
  redirect("/settings");
}
