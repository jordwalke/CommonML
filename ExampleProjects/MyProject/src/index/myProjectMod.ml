let myProjectValue =
  "this is a value from my internal utility module" ^
    Util.myUtilVal


let x = if true then Util.myUtilVal else CommonMLExampleDependency.Util.yourUtilVal

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
