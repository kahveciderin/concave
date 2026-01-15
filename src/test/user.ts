import { createResourceFilter } from "@/resource/filter";
import { FetchSseTransport, ResourceRepository } from "./lib";
import { usersTable } from "@/db/schema";

type User = { id: number; name: string; age: number; email: string };

const transport = new FetchSseTransport<User>("http://localhost:5253/");
const filterer = createResourceFilter(usersTable);
const usersRepo = new ResourceRepository<User>(
  "user",
  (u) => u.id.toString(),
  transport,
  filterer
);

const q = usersRepo.get(`age>=18`);
const unsub = q.subscribe((items) => console.log("adults:", items));

setTimeout(() => {
  usersRepo.create({ name: "hello", age: 54, email: "gsfdsfd" });
}, 5000);
