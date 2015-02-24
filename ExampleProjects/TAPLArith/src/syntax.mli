(** Syntax trees and associated support functions *)

open Support.Pervasive

type info = Support.Error.info

(** Data type definitions *)
type term =
    TmTrue of info
  | TmFalse of info
  | TmIf of info * term * term * term
  | TmZero of info
  | TmSucc of info * term
  | TmPred of info * term
  | TmIsZero of info * term

type command =
  | Eval of info * term



(** Print a term to stdout *)
val printtm: term -> unit
val printtm_ATerm: bool -> term -> unit

(* Misc *)
val tmInfo: term -> info
