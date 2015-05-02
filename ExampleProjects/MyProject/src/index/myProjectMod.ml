let myProjectValue =
  "this is a value from my internal utility module" ^
    Util.myUtilVal

(* Using the latest js_of_ocaml compiler for latest debugging features:

     cd ~/github/
     git clone https://github.com/ocsigen/js_of_ocaml
     cd ./js_of_ocaml
     opam pin add js_of_ocaml .
*)

(* Steps To Debug OCaml in the browser

   0. Make sure OCaml/OPAM/js_of_ocaml are installed.
   1. git clone github.com/jordwalke/CommonML
   2. cd CommonML/ExampleProjects/MyProject
   3. npm install
   4. node ../../build.js --forDebug=true --jsCompile=true
   6. In Chrome, open ./webAppRoot/index.html

*)


let rec testHelperFunction x y =
  if x > 10 || y > 10 then
    "\nReturn String From testHelperFunction!\n"
  else
    let doubleX = x * x in
    let doubleY = y * y in
    testHelperFunction doubleX doubleY


let x = if true then Util.myUtilVal else CommonMLExampleDependency.Util.yourUtilVal
let randomizedStringToPrint =
  if Random.int 10 > 4 then "biggerThanFour" else "smallerThanFour"

let _ = print_string ("Random number is " ^ randomizedStringToPrint)

let randomizedStringToPrintBetterFormatting =
  if Random.int 10 > 4
  then "biggerThanFour"
  else "smallerThanFour"

let _ = print_string ("Random number is " ^ randomizedStringToPrintBetterFormatting)

type opaquifiedYourProjectType =
    CommonMLExampleDependency.ExampleMod.yourProjectType

(* Cannot access a module that we didn't explicitly depend on in package.json *)
(* Uncomment to verify it is correctly prevented *)
(* let _ = CommonMLAnotherExampleDependency.AnotherExampleMod.obscureValue *)

let reexportedYourValue:opaquifiedYourProjectType =
  CommonMLExampleDependency.ExampleMod.yourProjectValue


(* Private non-exported modules of dependencies may not be relied upon. *)
(* Uncomment to verify it is correctly prevented *)
(* let _ = CommonMLExampleDependency.PrivateModule.privateVal *)

let _ = CommonMLExampleDependency.Util.yourUtilVal
let _ = print_string myProjectValue

let _ = TestNestedModuleName.NestedSubmodule.NestedSubmodule.nestedVal


let _ = print_string (testHelperFunction 1 3)
